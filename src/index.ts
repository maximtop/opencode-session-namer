/**
 * opencode-session-namer — gives opencode sessions meaningful names.
 *
 * What it does, once per session, right after the first user message:
 * - PR link in the first message → [<repo>] [<key>] Review pull/<N> <title>
 * - otherwise, inside a git project → [<project>] [<key>] <auto-title>
 *
 * The issue key (e.g. AG-123) comes from the PR branch/title or the branch
 * recorded in `.git/HEAD` — no issue-tracker API calls. Linked worktrees are
 * detected generically through the `.git` file, so the label is the main
 * repo name and the key comes from the worktree branch. A title set by
 * anything other than the built-in auto-title (manual rename, another tool)
 * marks the session as foreign and it is never renamed. A session is
 * renamed at most once, ever.
 */

import type { Plugin } from '@opencode-ai/plugin';
import { loadConfig } from './config';
import { loadState, saveState } from './state';
import { createRenamer } from './rename';
import { classifyTitleChange } from './tracking';
import type {
    AgKeyExtractor,
    LogFn,
    SessionInfo,
    TrackedSession,
} from './types';

/**
 * Event properties shapes that carry a session id — info-wrapped for
 * session.* events, flat for message.updated.
 */
interface EventProps {
    /**
     * Session payload of session.* events.
     */
    info?: {
        /**
         * Session id on session.* events.
         */
        id?: string;
        /**
         * Session id on chat.params-style payloads.
         */
        sessionID?: string;
    };
    /**
     * Session id on message.updated events.
     */
    sessionID?: string;
}

/**
 * The plugin factory. Loads config and state, wires the renamer and returns
 * the event hook that schedules a one-time rename on the first user
 * message, with the first idle as fallback.
 * @param ctx plugin context provided by opencode
 * @param ctx.client opencode SDK client
 * @returns plugin hooks
 */
export const SessionNamer: Plugin = async ({ client }) => {
    const log: LogFn = (level, message, extra) => {
        client.app
            .log({ body: { service: 'session-namer', level, message, extra } })
            .catch(() => {});
    };

    const config = await loadConfig();
    const extractAgKey: AgKeyExtractor = (text) => {
        if (!text) {
            return null;
        }
        try {
            const agKeyRe = new RegExp(config.agKeyPattern);
            const match = String(text).match(agKeyRe);
            return match ? (match[1] ?? match[0]) : null;
        } catch {
            // invalid configured pattern: treat as "no key found"
            return null;
        }
    };

    const state = await loadState(log);
    const tracked = new Map<string, TrackedSession>();

    const recordFor = (sessionID: string): TrackedSession => {
        let rec = tracked.get(sessionID);
        if (!rec) {
            rec = {
                sawUserMessage: false,
                autoTitle: undefined,
                foreign: false,
                scheduled: false,
                lastTitle: undefined,
                renameAttempts: 0,
                child: false,
                givenUp: false,
                directory: undefined,
            };
            tracked.set(sessionID, rec);
        }
        return rec;
    };

    const markProcessed = async (
        sessionID: string,
        appliedTitle?: string,
    ): Promise<void> => {
        state.processed[sessionID] = Date.now();
        if (appliedTitle) {
            state.appliedTitles[sessionID] = appliedTitle;
        }
        await saveState(state, log);
    };

    const releaseScheduled = (sessionID: string): void => {
        const rec = tracked.get(sessionID);
        if (rec) {
            rec.scheduled = false;
        }
    };

    /**
     * Forgets the title we applied, closing the late-auto-title correction
     * window, and persists the state.
     * @param sessionID session whose applied title is dropped
     */
    const forgetAppliedTitle = async (sessionID: string): Promise<void> => {
        if (!(sessionID in state.appliedTitles)) {
            return;
        }
        delete state.appliedTitles[sessionID];
        await saveState(state, log);
    };

    const rename = createRenamer({
        client,
        config,
        extractAgKey,
        log,
        state,
        tracked,
        markProcessed,
        releaseScheduled,
    });

    /**
     * Arms the delayed rename for a session. The rename itself is retry-safe
     * (it releases the latch on transient outcomes).
     * @param sessionID session to rename
     */
    const schedule = (sessionID: string): void => {
        if (state.processed[sessionID]) {
            return;
        }
        const rec = recordFor(sessionID);
        if (rec.child || rec.givenUp) {
            return;
        }
        if (rec.foreign) {
            log('info', 'skipping session with a foreign title', {
                sessionID,
            });
            return;
        }
        if (rec.scheduled) {
            return;
        }
        rec.scheduled = true;
        setTimeout(async () => {
            try {
                await rename(sessionID);
            } catch (e) {
                log('error', 'rename failed, will retry on next idle', {
                    sessionID,
                    error: String(e),
                });
                releaseScheduled(sessionID);
            }
        }, config.renameDelayMs);
    };

    /**
     * Re-applies our title exactly once when a late re-write of the recorded
     * auto-title overwrites it before the first idle. A title from any other
     * source — a manual rename, another tool — is never touched: it wins and
     * closes the correction window.
     * @param sessionID session whose title changed
     * @param info session info from the session.updated event
     */
    const correctLateAutoTitle = async (
        sessionID: string,
        info: SessionInfo,
    ): Promise<void> => {
        const applied = state.appliedTitles[sessionID];
        if (!applied || info.title === applied) {
            return;
        }
        const rec = tracked.get(sessionID);
        if (rec?.autoTitle === undefined || info.title !== rec.autoTitle) {
            await forgetAppliedTitle(sessionID);
            return;
        }
        const res = await client.session.update({
            path: { id: sessionID },
            query: { directory: info.directory },
            body: { title: applied },
        });
        if (res.error) {
            // keep the correction armed — a later title change may retry
            log('warn', 'title re-apply failed, kept for retry', {
                sessionID,
                error: JSON.stringify(res.error),
            });
            return;
        }
        await forgetAppliedTitle(sessionID);
        log('info', 'restored title over late auto-title', {
            sessionID,
            title: applied,
        });
    };

    /**
     * Routes a title change: classification for unprocessed sessions, the
     * bounded correction window for processed ones.
     * @param info session info from the session.updated event
     */
    const onSessionUpdated = async (
        info: SessionInfo | undefined,
    ): Promise<void> => {
        if (!info?.id) {
            return;
        }
        if (state.processed[info.id]) {
            await correctLateAutoTitle(info.id, info);
            return;
        }
        const rec = recordFor(info.id);
        if (info.directory) {
            rec.directory = info.directory;
        }
        const patch = classifyTitleChange(rec, info.title ?? '');
        rec.foreign = patch.foreign;
        rec.autoTitle = patch.autoTitle;
        rec.lastTitle = patch.lastTitle;
    };

    /**
     * Handles the idle fallback: ends the correction window for processed
     * sessions, retires foreign ones, re-arms the rename for the rest.
     * @param sessionID session that went idle
     */
    const onSessionIdle = async (sessionID: string): Promise<void> => {
        if (state.processed[sessionID]) {
            // the correction window ends at the first idle after the
            // rename — drop the tracked record then
            tracked.delete(sessionID);
            await forgetAppliedTitle(sessionID);
            return;
        }
        const rec = recordFor(sessionID);
        if (rec.child) {
            // throwaway child sessions are deleted by their owner — drop
            // tracking instead of persisting a processed entry
            tracked.delete(sessionID);
            return;
        }
        if (rec.foreign) {
            // foreign sessions are never renamed — stop tracking them
            log('info', 'skipping session with a foreign title', {
                sessionID,
            });
            await markProcessed(sessionID);
            tracked.delete(sessionID);
            return;
        }
        schedule(sessionID);
    };

    return {
        /**
         * Tracks sessions and schedules the rename. `message.updated` is the
         * fast path (rename right after the first user message — long first
         * turns would otherwise delay the rename until the first idle).
         * `session.updated` tells the built-in auto-title apart from manual
         * renames and corrects a late re-write of the recorded auto-title
         * once, before the first idle. `session.idle` is the fallback path
         * for sessions restored before the plugin saw their first message.
         * `session.deleted` drops tracking for removed sessions.
         * @param input opencode event envelope
         * @param input.event the event payload
         */
        event: async ({ event }) => {
            try {
                if (event.type === 'session.created') {
                    const info = event.properties?.info;
                    if (info?.id) {
                        const rec = recordFor(info.id);
                        rec.lastTitle = info.title;
                        rec.directory = info.directory;
                        rec.child = Boolean(info.parentID);
                    }
                    return;
                }
                if (event.type === 'session.deleted') {
                    const sessionID = event.properties?.info?.id;
                    if (sessionID) {
                        tracked.delete(sessionID);
                    }
                    return;
                }
                if (event.type === 'session.updated') {
                    await onSessionUpdated(event.properties?.info);
                    return;
                }
                if (event.type === 'message.updated') {
                    const info = event.properties?.info;
                    if (info?.role === 'user' && info.sessionID) {
                        const rec = recordFor(info.sessionID);
                        if (rec.child) {
                            return;
                        }
                        const first = !rec.sawUserMessage;
                        rec.sawUserMessage = true;
                        // a freshly arrived user message is new evidence:
                        // retry a given-up session, reset its attempt budget
                        // and re-arm the latch a prior give-up left set
                        if (rec.givenUp) {
                            rec.givenUp = false;
                            rec.renameAttempts = 0;
                            rec.scheduled = false;
                        }
                        if (first) {
                            schedule(info.sessionID);
                        }
                    }
                    return;
                }
                if (event.type === 'session.idle') {
                    const sessionID = event.properties?.sessionID;
                    if (sessionID) {
                        await onSessionIdle(sessionID);
                    }
                }
            } catch (e) {
                const props = event.properties as EventProps | undefined;
                const sessionID = props?.info?.id
                    ?? props?.info?.sessionID
                    ?? props?.sessionID;
                log('error', 'event handler failed', {
                    sessionID,
                    error: String(e),
                    event: event.type,
                });
            }
        },
    };
};
