import { findPrUrl } from './pr-link';
import { createPrLinkExtractor } from './pr-link-llm';
import { fetchGhPrInfo } from './github';
import { messageText } from './messages';
import { projectForDirectory } from './project';
import { createSmartShorten } from './shorten';
import {
    applyTemplate,
    deriveBase,
    expandSlots,
    humanize,
    truncateAtWord,
} from './text';
import { DEFAULT_TITLE_RE } from './tracking';
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

/**
 * Rename attempts without any user text before the session is given up —
 * bounds the refetch-every-idle loop for all-synthetic sessions.
 */
const MAX_RENAME_ATTEMPTS = 10;

/**
 * Matches Unicode format characters (Cf) — bidi overrides, zero-width
 * spaces, the BOM — that C0/C1 filtering alone lets through and that can
 * spoof how a title displays.
 */
const FORMAT_CHAR_RE = /\p{Cf}/u;

/**
 * Escapes a string for literal use inside a RegExp. Issue keys come from
 * externally supplied branch/PR titles via the configured pattern, so they
 * can contain regex metacharacters.
 * @param value raw string
 * @returns escaped string
 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Dependencies wired into the renamer by the plugin entry.
 */
interface RenamerDeps {
    /**
     * opencode SDK client.
     */
    client: PluginClient;
    /**
     * Effective plugin configuration.
     */
    config: PluginConfig;
    /**
     * Issue key extractor built from the configured pattern.
     */
    extractAgKey: AgKeyExtractor;
    /**
     * Leveled logger bound to the opencode app log.
     */
    log: LogFn;
    /**
     * Rename-once persistence state.
     */
    state: State;
    /**
     * Per-session in-memory tracking map.
     */
    tracked: Map<string, TrackedSession>;
    /**
     * Marks a session as processed and persists the state file; the applied
     * title is kept until the session first goes idle so a late auto-title
     * write can be corrected once.
     */
    markProcessed: (sessionID: string, appliedTitle?: string) => Promise<void>;
    /**
     * Releases the scheduled latch so a later idle can retry.
     */
    releaseScheduled: (sessionID: string) => void;
}

/**
 * Title parts for composeTitle.
 */
interface ComposeInput {
    /**
     * Project label, e.g. "filters registry".
     */
    project: string;
    /**
     * Issue key or null when none was found.
     */
    agKey: string | null;
    /**
     * Structural prefix kept as is (e.g. the PR reference).
     */
    keepPrefix?: string;
    /**
     * Descriptive part, shortened when the result is too long.
     */
    desc: string;
    /**
     * Session being renamed (smartShorten parent).
     */
    sessionID: string;
    /**
     * Working directory for smartShorten.
     */
    directory: string;
}

/**
 * Wires the rename orchestration: reads the session, decides the new title
 * (PR-based or project-based) and writes it once.
 * @param deps plugin dependencies
 * @returns rename function; retryable outcomes release the scheduled latch
 * so a later idle re-arms the rename
 */
export function createRenamer(deps: RenamerDeps) {
    const {
        client, config, extractAgKey, log, state, tracked, markProcessed,
        releaseScheduled,
    } = deps;
    const smartShorten = createSmartShorten(client, config);
    const extractPrLink = createPrLinkExtractor(client, config, log);

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
                    sessionID,
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
        const info: PrInfo | null = await fetchGhPrInfo(pr, log);
        const agKey = extractAgKey(info?.branch)
            ?? extractAgKey(info?.title);
        // PR titles often start with the issue key ("AG-31699: Add …") —
        // don't repeat it after the prefix.
        const title = info?.title && agKey
            ? info.title.replace(
                new RegExp(`^${escapeRegExp(agKey)}[:\\s-]*`),
                '',
            )
            : info?.title ?? null;
        const prefix = expandSlots(config.prPrefix, { number: pr.number });
        return composeTitle({
            project,
            agKey,
            keepPrefix: prefix,
            desc: title ?? '',
            sessionID,
            directory,
        });
    }

    /**
     * Removes C0/C1 control characters and Unicode format characters (bidi
     * overrides, zero-width) so externally sourced titles can neither inject
     * terminal control sequences nor spoof how the title displays.
     * @param input title under construction
     * @returns sanitized title
     */
    function sanitize(input: string): string {
        return Array.from(input)
            .filter((ch) => {
                const code = ch.codePointAt(0) ?? 0;
                const printable = code < 128 || code >= 160;
                return code >= 32
                    && code !== 127
                    && printable
                    && !FORMAT_CHAR_RE.test(ch);
            })
            .join('');
    }

    /**
     * Renames the session if it is eligible: not processed yet, not foreign,
     * not a sub-agent session, and the current title is either default or
     * the recorded auto-title. Retryable outcomes (transient reads, a failed
     * title write, no user message yet) release the scheduled latch so a
     * later idle re-arms the rename.
     * @param sessionID session to rename
     */
    return async function rename(sessionID: string): Promise<void> {
        if (state.processed[sessionID]) {
            return;
        }
        const rec = tracked.get(sessionID);
        if (rec?.foreign) {
            log('info', 'skipping session with a foreign title', {
                sessionID,
            });
            await markProcessed(sessionID);
            return;
        }

        const got = await client.session.get({ path: { id: sessionID } });
        const session = got.data;
        if (!session) {
            // transient — try again on a later idle
            releaseScheduled(sessionID);
            return;
        }
        if (session.parentID) {
            // subagent sessions name themselves
            log('info', 'skipping sub-agent session', { sessionID });
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
                log('info', 'skipping title not produced by the auto-title', {
                    sessionID,
                });
                await markProcessed(sessionID);
                return;
            }
        }

        const messages = await client.session.messages({
            path: { id: sessionID },
            query: { directory: session.directory, limit: 25 },
        });
        const text = messageText(messages.data ?? [], 'user', 'first');
        if (!text) {
            // no user message yet (idle before the first message) — retry
            // on a later idle, but give up on sessions that never get one
            const attempts = (rec?.renameAttempts ?? 0) + 1;
            if (rec) {
                rec.renameAttempts = attempts;
            }
            if (attempts > MAX_RENAME_ATTEMPTS) {
                log('warn', 'giving up: still no user message', {
                    sessionID,
                    attempts,
                });
                await markProcessed(sessionID);
                return;
            }
            releaseScheduled(sessionID);
            return;
        }

        let title: string | null = null;
        let pr = findPrUrl(text);
        if (!pr && config.prLinkLlm) {
            // no URL-shaped token — ask a small model which PR is referenced
            try {
                pr = await extractPrLink(text, sessionID, session.directory);
            } catch (e) {
                log('warn', 'pr-link llm extraction failed, naming by project', {
                    sessionID,
                    error: String(e),
                });
            }
        }
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

        const safe = title ? sanitize(title) : null;
        if (safe && safe !== session.title) {
            const res = await client.session.update({
                path: { id: sessionID },
                query: { directory: session.directory },
                body: { title: safe },
            });
            if (res.error) {
                // a failed write must not consume the rename-once budget —
                // retry on a later idle
                log('warn', 'title write failed, will retry on next idle', {
                    sessionID,
                    error: JSON.stringify(res.error),
                });
                releaseScheduled(sessionID);
                return;
            }
            log('info', 'renamed session', { sessionID, title: safe });
            await markProcessed(sessionID, safe);
            return;
        }
        log('info', 'no rename needed', { sessionID });
        await markProcessed(sessionID);
    };
}
