import { findPrUrl } from './pr-link';
import { fetchGhPrInfo } from './github';
import { projectForDirectory } from './project';
import { createSmartShorten } from './shorten';
import { applyTemplate, deriveBase, humanize, truncateAtWord } from './text';
import type {
    AgKeyExtractor,
    LogFn,
    PluginClient,
    PluginConfig,
    PrInfo,
    PrLink,
    State,
    TrackedSession,
} from './types';

const DEFAULT_TITLE_RE = /^New session( - |$)/;

/** Dependencies wired into the renamer by the plugin entry. */
interface RenamerDeps {
    /** opencode SDK client. */
    client: PluginClient;
    /** Effective plugin configuration. */
    config: PluginConfig;
    /** Issue key extractor built from the configured pattern. */
    extractAgKey: AgKeyExtractor;
    /** Leveled logger bound to the opencode app log. */
    log: LogFn;
    /** Rename-once persistence state. */
    state: State;
    /** Per-session in-memory tracking map. */
    tracked: Map<string, TrackedSession>;
    /** Marks a session as processed and persists the state file. */
    markProcessed: (id: string) => Promise<void>;
}

/** Title parts for composeTitle. */
interface ComposeInput {
    /** Project label, e.g. "filters registry". */
    project: string;
    /** Issue key or null when none was found. */
    agKey: string | null;
    /** Structural prefix kept as is (e.g. the PR reference). */
    keepPrefix?: string;
    /** Descriptive part, shortened when the result is too long. */
    desc: string;
    /** Session being renamed (smartShorten parent). */
    sessionID: string;
    /** Working directory for smartShorten. */
    directory: string;
}

/**
 * Wires the rename orchestration: reads the session, decides the new title
 * (PR-based or project-based) and writes it once.
 * @param deps plugin dependencies
 * @returns rename function
 */
export function createRenamer(deps: RenamerDeps) {
    const {
        client, config, extractAgKey, log, state, tracked, markProcessed,
    } = deps;
    const smartShorten = createSmartShorten(client, config);

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
    async function composeTitle(input: ComposeInput): Promise<string> {
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

    /**
     * Builds the PR-based title: fetches PR data via gh, extracts the issue
     * key and composes the final name.
     * @param pr parsed PR link
     * @param sessionID session being renamed
     * @param directory session working directory
     * @returns final session title
     */
    async function prTitle(
        pr: PrLink,
        sessionID: string,
        directory: string,
    ): Promise<string> {
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
        const title = info?.title && agKey
            ? info.title.replace(new RegExp(`^${agKey}[:\\s-]*`), '')
            : info?.title ?? null;
        // prPrefix keeps its trailing space: expand slots without trim.
        const prefix = config.prPrefix.replace(
            /\{(\w+)\}/g,
            (_, key: string) => ({ number: pr.number })[key] ?? '',
        );
        return composeTitle({
            project,
            agKey,
            keepPrefix: title ? prefix : prefix.trimEnd(),
            desc: title ?? '',
            sessionID,
            directory,
        });
    }

    /**
     * Renames the session if it is eligible: not processed yet, not foreign,
     * not a sub-agent session, and the current title is either default or
     * the recorded auto-title.
     * @param sessionID session to rename
     */
    return async function rename(sessionID: string): Promise<void> {
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
            title = await prTitle(pr, sessionID, session.directory);
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
    };
}
