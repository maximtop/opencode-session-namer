/**
 * opencode-session-namer — gives opencode sessions meaningful names.
 *
 * What it does, once per session, shortly after the first reply settles:
 * - PR link in the first message → [<repo>] [<key>] Review pull/<N> <title>
 * - otherwise, inside a git project → [<project>] [<key>] <auto-title>
 *
 * The issue key (e.g. AG-123) comes from the PR branch/title or the current
 * branch — no issue-tracker API calls. Worktrees are detected generically
 * through the `.git` file, so the label is the main repo name and the key
 * comes from the worktree branch. A title set by anything other than the
 * built-in auto-title (manual rename, another tool) marks the session as
 * foreign and it is never renamed. A session is renamed at most once, ever.
 */

import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { Plugin } from '@opencode-ai/plugin';

const URL_SCAN_CHARS = 2000;
const CONFIG_FILE = process.env.SESSION_NAMER_CONFIG
    ?? join(homedir(), '.config', 'opencode', 'session-namer.json');
const STATE_FILE = process.env.SESSION_NAMER_STATE
    ?? join(homedir(), '.config', 'opencode', 'session-namer.state.json');
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TITLE_RE = /^New session( - |$)/;

interface PluginConfig {
    template: string;
    prPrefix: string;
    agKeyPattern: string;
    maxLength: number;
    smartShorten: boolean;
    smartShortenModel: string | null;
    renameDelayMs: number;
}

const DEFAULTS: PluginConfig = {
    template: '[{project}] {agKey} {title}',
    prPrefix: 'Review pull/{number} ',
    agKeyPattern: '[A-Z][A-Z0-9]{1,9}-\\d+',
    maxLength: 90,
    smartShorten: false,
    smartShortenModel: null,
    renameDelayMs: 10000,
};

interface PrLink {
    host: string;
    owner: string;
    repo: string;
    number: string;
}

interface ProjectInfo {
    label: string;
    agKey: string | null;
}

interface PrInfo {
    title: string | null;
    branch: string | null;
}

interface State {
    processed: Record<string, number>;
}

interface TrackedSession {
    sawUserMessage: boolean;
    autoTitle: string | undefined;
    foreign: boolean;
    scheduled: boolean;
    lastTitle: string | undefined;
}

const execFileAsync = promisify(execFile);

/**
 * Turns a directory or repo name into a display label:
 * "FiltersRegistry" → "filters registry", "browser-extension" stays as is.
 * @param name raw directory or repository name
 * @returns display label
 */
function humanize(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/_+/g, ' ')
        .toLowerCase()
        .trim();
}

/**
 * Cuts text at the last word boundary before `max` characters.
 * @param text text to cut
 * @param max maximum length
 * @returns cut text
 */
function truncateAtWord(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    const cut = text.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    const head = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
    return head.trimEnd();
}

/**
 * Substitutes {slot} placeholders. Separators left dangling by an empty
 * slot (e.g. "|" in "{project} | {agKey} | {title}") are cleaned up.
 * @param template template string with {slot} placeholders
 * @param slots slot values; empty slots collapse
 * @returns rendered string
 */
function applyTemplate(
    template: string,
    slots: Record<string, string>,
): string {
    return template
        .replace(/\{(\w+)\}/g, (_, key: string) => slots[key] ?? '')
        .replace(/\s*([|—–·•/-])\s*(?=[|—–·•/-])/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s*[|—–·•/-]\s*$/g, '')
        .trim();
}

/**
 * Finds the target PR link in the first user message. Review prompt
 * templates tend to carry example links further down, so only the head of
 * the message is scanned and deep links (#fragments, ?queries) are skipped.
 * @param text first user message text
 * @returns parsed PR link or null
 */
function findPrUrl(text: string): PrLink | null {
    const head = text.slice(0, URL_SCAN_CHARS);
    const urls = head.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? [];
    for (const raw of urls) {
        const url = raw.replace(/[.,;:!?]+$/, '');
        if (url.includes('#') || url.includes('?')) {
            continue;
        }
        const match = url.match(
            /^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/,
        );
        if (match) {
            const [, host, owner, repo, number] = match;
            if (host && owner && repo && number) {
                return { host, owner, repo, number };
            }
        }
    }
    return null;
}

/**
 * Reads the issue key from the branch recorded in a worktree HEAD file.
 * @param gitdir worktree gitdir path
 * @param extractAgKey issue key extractor
 * @returns issue key or null
 */
async function branchAgKey(
    gitdir: string,
    extractAgKey: (text: string | null | undefined) => string | null,
): Promise<string | null> {
    try {
        const head = await fsp.readFile(join(gitdir, 'HEAD'), 'utf8');
        const match = head.match(/ref:\s*refs\/heads\/(.+)/);
        return match?.[1] ? extractAgKey(match[1].trim()) : null;
    } catch {
        return null;
    }
}

/**
 * Resolves the project label from the session directory.
 *
 * - Regular checkout: the directory basename.
 * - Linked worktree: `.git` is a file pointing into the main repo, so the
 * label is the main repo name and the key comes from the branch.
 * - Scratch dirs (chats, tmp, non-git) → null, session keeps the auto-title.
 * @param dir session directory
 * @param extractAgKey issue key extractor
 * @returns project info or null for scratch dirs
 */
async function projectForDirectory(
    dir: string | undefined,
    extractAgKey: (text: string | null | undefined) => string | null,
): Promise<ProjectInfo | null> {
    if (!dir) {
        return null;
    }
    const isScratch = dir.includes('/.config/openchamber/chats/')
        || dir.startsWith(tmpdir())
        || dir.startsWith('/tmp/')
        || dir.startsWith('/var/folders/');
    if (isScratch) {
        return null;
    }
    const gitPath = join(dir, '.git');
    let stat;
    try {
        stat = await fsp.lstat(gitPath);
    } catch {
        return null;
    }
    if (stat.isDirectory()) {
        return { label: humanize(basename(dir)), agKey: null };
    }
    if (!stat.isFile()) {
        return null;
    }
    const fallback: ProjectInfo = {
        label: humanize(basename(dir)),
        agKey: null,
    };
    try {
        const content = await fsp.readFile(gitPath, 'utf8');
        const gitdirLine = content.match(/gitdir:\s*(.+)/);
        if (!gitdirLine?.[1]) {
            return fallback;
        }
        const gitdir = gitdirLine[1].trim();
        const worktree = gitdir.match(
            /^(.*?)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/,
        );
        if (!worktree?.[1]) {
            return fallback; // submodule or other layout
        }
        const agKey = await branchAgKey(gitdir, extractAgKey);
        return { label: humanize(basename(worktree[1])), agKey };
    } catch {
        return fallback;
    }
}

/**
 * Derives a fallback title from the first line of the user message.
 * @param messageText first user message text
 * @param maxLength length cap for the derived part
 * @returns derived title or null
 */
function deriveBase(messageText: string, maxLength: number): string | null {
    const line = messageText
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
    if (!line) {
        return null;
    }
    return truncateAtWord(line.replace(/\s+/g, ' '), Math.min(50, maxLength));
}

async function loadConfig(): Promise<PluginConfig> {
    try {
        const raw = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
        return { ...DEFAULTS, ...raw };
    } catch {
        return { ...DEFAULTS };
    }
}

async function loadState(): Promise<State> {
    try {
        const parsed = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
        const now = Date.now();
        const processed = (parsed.processed ?? {}) as Record<string, number>;
        const entries = Object.entries(processed)
            .filter(([, ts]) => now - ts < STATE_TTL_MS);
        return { processed: Object.fromEntries(entries) };
    } catch {
        return { processed: {} };
    }
}

async function saveState(state: State): Promise<void> {
    try {
        await fsp.mkdir(dirname(STATE_FILE), { recursive: true });
        await fsp.writeFile(STATE_FILE, JSON.stringify(state));
    } catch {
        // best effort
    }
}

/**
 * Fetches PR title and head branch via the gh CLI (GH_HOST for GHES).
 * @param pr parsed PR link
 * @returns PR info or null on any failure
 */
async function fetchGhPrInfo(pr: PrLink): Promise<PrInfo | null> {
    const host = pr.host.replace(/^https?:\/\//, '');
    const env = host === 'github.com'
        ? process.env
        : { ...process.env, GH_HOST: host };
    const args = [
        'pr', 'view', pr.number,
        '--repo', `${pr.owner}/${pr.repo}`,
        '--json', 'title,headRefName',
    ];
    try {
        const { stdout } = await execFileAsync('gh', args, { env });
        const parsed = JSON.parse(stdout);
        return {
            title: parsed.title ?? null,
            branch: parsed.headRefName ?? null,
        };
    } catch {
        return null;
    }
}

export const SessionNamer: Plugin = async ({ client }) => {
    const log = (
        level: 'info' | 'warn' | 'error',
        message: string,
        extra?: Record<string, unknown>,
    ) => {
        client.app
            .log({ body: { service: 'session-namer', level, message, extra } })
            .catch(() => {});
    };

    const config = await loadConfig();
    config.renameDelayMs = Number(
        process.env.SESSION_NAMER_DELAY_MS ?? config.renameDelayMs,
    );
    const agKeyRe = new RegExp(config.agKeyPattern);
    const extractAgKey = (text: string | null | undefined): string | null => {
        if (!text) {
            return null;
        }
        const match = String(text).match(agKeyRe);
        return match ? (match[1] ?? match[0]) : null;
    };

    const state = await loadState();
    const tracked = new Map<string, TrackedSession>();

    const recordFor = (id: string): TrackedSession => {
        let rec = tracked.get(id);
        if (!rec) {
            rec = {
                sawUserMessage: false,
                autoTitle: undefined,
                foreign: false,
                scheduled: false,
                lastTitle: undefined,
            };
            tracked.set(id, rec);
        }
        return rec;
    };

    const markProcessed = async (id: string): Promise<void> => {
        state.processed[id] = Date.now();
        await saveState(state);
    };

    /**
     * Returns the text of the first real (non-synthetic) user message.
     * @param sessionID session to read
     * @param directory session working directory
     * @returns message text or null
     */
    async function firstUserText(
        sessionID: string,
        directory: string,
    ): Promise<string | null> {
        const res = await client.session.messages({
            path: { id: sessionID },
            query: { directory, limit: 50 },
        });
        const users = (res.data ?? [])
            .filter((m) => m.info?.role === 'user')
            .sort(
                (a, b) => (a.info.time?.created ?? 0)
                    - (b.info.time?.created ?? 0),
            );
        for (const message of users) {
            const texts: string[] = [];
            for (const part of message.parts ?? []) {
                if (part.type === 'text' && !part.synthetic && part.text.trim()) {
                    texts.push(part.text);
                }
            }
            if (texts.length > 0) {
                return texts.join('\n');
            }
        }
        return null;
    }

    /**
     * LLM-shortens an overlong descriptive part via a throwaway child
     * session. Any failure propagates — the caller falls back to truncation.
     * @param text text to shorten
     * @param budget maximum length of the result
     * @param parentSessionID session the child is attached to
     * @param directory working directory for the child session
     * @returns shortened text
     */
    async function smartShorten(
        text: string,
        budget: number,
        parentSessionID: string,
        directory: string,
    ): Promise<string> {
        let model: { providerID: string; modelID: string } | undefined;
        const modelRef = config.smartShortenModel;
        const cfg = modelRef ? null : await client.config.get();
        const resolved = modelRef
            ?? (typeof cfg?.data?.small_model === 'string'
                ? cfg.data.small_model
                : null);
        if (resolved && resolved.includes('/')) {
            const [providerID, modelID] = resolved.split('/');
            if (providerID && modelID) {
                model = { providerID, modelID };
            }
        }
        const child = await client.session.create({
            body: { parentID: parentSessionID, title: 'session-namer: shorten' },
            query: { directory },
        });
        const childID = child.data?.id;
        if (!childID) {
            throw new Error('failed to create shorten session');
        }
        try {
            await client.session.prompt({
                path: { id: childID },
                query: { directory },
                body: {
                    ...(model ? { model } : {}),
                    parts: [{
                        type: 'text',
                        text: [
                            `Shorten the following title to at most ${budget}`,
                            'characters. Keep the same language and the key',
                            'technical terms. Reply with the shortened title',
                            'only — no quotes, no explanations.',
                            '',
                            text,
                        ].join('\n'),
                    }],
                },
            });
            const msgs = await client.session.messages({
                path: { id: childID },
                query: { directory },
            });
            const assistants = (msgs.data ?? [])
                .filter((m) => m.info?.role === 'assistant')
                .sort(
                    (a, b) => (b.info.time?.created ?? 0)
                        - (a.info.time?.created ?? 0),
                );
            let shortened: string | undefined;
            for (const message of assistants) {
                for (const part of message.parts ?? []) {
                    if (part.type === 'text' && part.text.trim()) {
                        shortened = part.text.trim().split('\n')[0]?.trim();
                        break;
                    }
                }
                if (shortened) {
                    break;
                }
            }
            if (!shortened) {
                throw new Error('empty shorten reply');
            }
            return shortened.length > budget + 10
                ? truncateAtWord(shortened, budget)
                : shortened;
        } finally {
            await client.session
                .delete({ path: { id: childID }, query: { directory } })
                .catch(() => {});
        }
    }

    /**
     * Composes the final title. When it exceeds maxLength, only the
     * descriptive part is shortened — the structural prefix and keepPrefix
     * (e.g. "Review pull/N ") stay intact.
     * @param input title parts
     * @param input.project project label
     * @param input.agKey issue key or null
     * @param input.keepPrefix structural prefix kept as is (PR reference)
     * @param input.desc descriptive part, shortened when too long
     * @param input.sessionID session being renamed (smartShorten parent)
     * @param input.directory working directory for smartShorten
     * @returns final session title
     */
    async function composeTitle(input: {
        project: string;
        agKey: string | null;
        keepPrefix?: string;
        desc: string;
        sessionID: string;
        directory: string;
    }): Promise<string> {
        const {
            project, agKey, keepPrefix = '', desc, sessionID, directory,
        } = input;
        const slots = { project, agKey: agKey ?? '' };
        const full = applyTemplate(config.template, {
            ...slots,
            title: keepPrefix + desc,
        });
        if (full.length <= config.maxLength) {
            return full;
        }
        const structural = applyTemplate(config.template, {
            ...slots,
            title: keepPrefix.trimEnd(),
        });
        const budget = Math.max(20, config.maxLength - structural.length - 1);
        let shortened: string | null = null;
        if (config.smartShorten) {
            try {
                shortened = await smartShorten(
                    desc,
                    budget,
                    sessionID,
                    directory,
                );
            } catch (e) {
                log('warn', 'smartShorten failed, falling back', {
                    error: String(e),
                });
            }
        }
        return applyTemplate(config.template, {
            ...slots,
            title: keepPrefix + (shortened ?? truncateAtWord(desc, budget)),
        });
    }

    async function rename(sessionID: string): Promise<void> {
        if (state.processed[sessionID]) {
            return;
        }
        const rec = tracked.get(sessionID);
        if (rec?.foreign) {
            await markProcessed(sessionID);
            return;
        }

        const got = await client.session.get({ path: { id: sessionID } });
        const session = got.data;
        if (!session) {
            return; // transient — try again on a later idle
        }
        if (session.parentID) {
            // subagent sessions name themselves
            await markProcessed(sessionID);
            return;
        }

        const isDefault = DEFAULT_TITLE_RE.test(session.title);
        if (!isDefault) {
            // Replace only the known auto-title. Anything else is a manual
            // or external rename — leave it alone.
            const isAutoTitle = rec?.autoTitle !== undefined
                && session.title === rec.autoTitle;
            if (!isAutoTitle) {
                await markProcessed(sessionID);
                return;
            }
        }

        const text = await firstUserText(sessionID, session.directory);
        if (!text) {
            await markProcessed(sessionID);
            return;
        }

        let title: string | null = null;
        const pr = findPrUrl(text);
        if (pr) {
            const project = humanize(pr.repo);
            let info: PrInfo | null = null;
            try {
                info = await fetchGhPrInfo(pr);
            } catch (e) {
                log('warn', 'PR fetch failed, naming from URL only', {
                    sessionID,
                    error: String(e),
                });
            }
            const agKey = extractAgKey(info?.branch)
                ?? extractAgKey(info?.title);
            // PR titles often start with the issue key ("AG-31699: Add …") —
            // don't repeat it after the prefix.
            const prTitle = info?.title && agKey
                ? info.title.replace(new RegExp(`^${agKey}[:\\s-]*`), '')
                : info?.title ?? null;
            // prPrefix keeps its trailing space: expand slots without trim.
            const prefix = config.prPrefix.replace(
                /\{(\w+)\}/g,
                (_, key: string) => ({ number: pr.number })[key] ?? '',
            );
            title = await composeTitle({
                project,
                agKey,
                keepPrefix: prTitle ? prefix : prefix.trimEnd(),
                desc: prTitle ?? '',
                sessionID,
                directory: session.directory,
            });
        } else {
            const dir = await projectForDirectory(
                session.directory,
                extractAgKey,
            );
            if (dir) {
                const base = isDefault
                    ? deriveBase(text, config.maxLength)
                    : session.title;
                if (base && !base.startsWith('[')) {
                    title = await composeTitle({
                        project: dir.label,
                        agKey: dir.agKey,
                        desc: base,
                        sessionID,
                        directory: session.directory,
                    });
                }
            }
        }

        if (title && title !== session.title) {
            await client.session.update({
                path: { id: sessionID },
                query: { directory: session.directory },
                body: { title },
            });
            log('info', 'renamed session', { sessionID, title });
        }
        await markProcessed(sessionID);
    }

    return {
        event: async ({ event }) => {
            try {
                if (event.type === 'session.created') {
                    const info = event.properties?.info;
                    if (info?.id) {
                        recordFor(info.id).lastTitle = info.title;
                    }
                    return;
                }
                if (event.type === 'session.updated') {
                    const info = event.properties?.info;
                    if (!info?.id || state.processed[info.id]) {
                        return;
                    }
                    const rec = recordFor(info.id);
                    const titleChanged = rec.lastTitle !== undefined
                        && rec.lastTitle !== info.title;
                    if (titleChanged) {
                        if (!rec.sawUserMessage) {
                            // titled before any user message (picker / manual)
                            rec.foreign = true;
                        } else if (rec.autoTitle === undefined) {
                            // first title after the first user message
                            rec.autoTitle = info.title;
                        } else if (info.title !== rec.autoTitle) {
                            // changed away from the auto-title = manual rename
                            rec.foreign = true;
                        }
                    }
                    rec.lastTitle = info.title;
                    return;
                }
                if (event.type === 'message.updated') {
                    const info = event.properties?.info;
                    if (info?.role === 'user' && info.sessionID) {
                        recordFor(info.sessionID).sawUserMessage = true;
                    }
                    return;
                }
                if (event.type === 'session.idle') {
                    const sessionID = event.properties?.sessionID;
                    if (!sessionID || state.processed[sessionID]) {
                        return;
                    }
                    const rec = recordFor(sessionID);
                    if (rec.foreign || rec.scheduled) {
                        return;
                    }
                    rec.scheduled = true;
                    setTimeout(() => {
                        rename(sessionID).catch((e) => log('error', 'rename failed', {
                            sessionID,
                            error: String(e),
                        }));
                    }, config.renameDelayMs);
                }
            } catch (e) {
                log('error', 'event handler failed', { error: String(e) });
            }
        },
    };
};
