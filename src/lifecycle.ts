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
 * initially renamed once, with one bounded late-auto-title correction.
 */

import { EventType } from './events';
import type { NamingHost, NamingEvent } from './host';
import { loadConfig } from './config';
import { loadState, saveState } from './state';
import { createRenamer } from './rename';
import { classifyTitleChange } from './tracking';
import type {
    AgKeyExtractor,
    SessionInfo,
    TrackedSession,
} from './types';

/**
 * Event envelope passed to the shared lifecycle.
 */
interface NamingEventInput {
    /**
     * Normalized host notification.
     */
    event: NamingEvent;
}

/**
 * The plugin factory. Loads config and state, wires the renamer and returns
 * the event hook that schedules a one-time rename on the first user
 * message, with the first idle as fallback.
 * @param host host operations and diagnostics
 * @returns plugin hooks
 */
export const createLifecycle = async (host: NamingHost) => {
    const { log } = host;

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
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const controllers = new Map<string, AbortController>();
    const jobs = new Set<Promise<void>>();
    const deleted = new Set<string>();
    const correcting = new Set<string>();
    let disposed = false;

    /**
     * Shares cancellation across pending operations for a session.
     * @param sessionID session whose controller is owned by this instance
     * @returns signal aborted on deletion, retirement or disposal
     */
    const signalFor = (sessionID: string): AbortSignal => {
        let controller = controllers.get(sessionID);
        if (!controller) {
            controller = new AbortController();
            controllers.set(sessionID, controller);
        }
        return controller.signal;
    };

    /**
     * Clears a session's timer and aborts its pending operations.
     * @param sessionID session whose work is cancelled
     */
    const cancelSession = (sessionID: string): void => {
        const timer = timers.get(sessionID);
        if (timer !== undefined) {
            clearTimeout(timer);
            timers.delete(sessionID);
        }
        controllers.get(sessionID)?.abort();
        controllers.delete(sessionID);
    };

    /**
     * Contains operation failures and tracks work until cleanup finishes.
     * @param work operation to start immediately
     * @returns settled operation, also awaited by disposal
     */
    const runJob = (work: () => Promise<void>): Promise<void> => {
        const job = work().catch(() => {
            if (!disposed) {
                log('error', 'session naming operation failed');
            }
        });
        jobs.add(job);
        job.then(() => jobs.delete(job));
        return job;
    };

    /**
     * Returns the session's provenance record, creating its initial state.
     * @param sessionID session being observed
     * @returns mutable record owned by this lifecycle
     */
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

    /**
     * Persists a terminal naming decision and optional correction window.
     * @param sessionID session that must not be named again
     * @param appliedTitle title eligible for one late-auto-title correction
     */
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

    /**
     * Allows a later event to retry a transient naming failure.
     * @param sessionID session whose scheduling latch is released
     */
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
        host,
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
        if (disposed || deleted.has(sessionID)) {
            return;
        }
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
        const signal = signalFor(sessionID);
        const timer = setTimeout(() => {
            timers.delete(sessionID);
            runJob(async () => {
                try {
                    signal.throwIfAborted();
                    await rename(sessionID, signal);
                } catch {
                    if (!signal.aborted) {
                        log('error', 'rename failed, will retry on next idle', {
                            sessionID,
                        });
                        releaseScheduled(sessionID);
                    }
                }
            });
        }, config.renameDelayMs);
        timers.set(sessionID, timer);
    };

    /**
     * Re-applies our title exactly once when a late re-write of the recorded
     * auto-title overwrites it before the first idle. A title from any other
     * source — a manual rename, another tool — is never touched: it wins and
     * closes the correction window.
     * @param sessionID session whose title changed
     * @param info session info from the session.updated event
     * @param signal cancellation of pending operations
     */
    const applyLateAutoTitle = async (
        sessionID: string,
        info: SessionInfo,
        signal: AbortSignal,
    ): Promise<void> => {
        const applied = state.appliedTitles[sessionID];
        const rec = tracked.get(sessionID);
        if (!applied || rec?.autoTitle === undefined) {
            return;
        }
        signal.throwIfAborted();
        const current = await host.getSession({
            sessionID, directory: info.directory ?? rec.directory, signal,
        });
        signal.throwIfAborted();
        if (state.appliedTitles[sessionID] !== applied
            || tracked.get(sessionID) !== rec) {
            return;
        }
        if (!current || current.title === applied) {
            return;
        }
        if (current.title !== rec.autoTitle) {
            await forgetAppliedTitle(sessionID);
            return;
        }
        const written = await host.updateTitle({
            sessionID, directory: current.directory, signal,
        }, applied);
        if (!written) {
            log('warn', 'title re-apply failed, kept for retry', { sessionID });
            return;
        }
        await forgetAppliedTitle(sessionID);
        log('info', 'restored title over late auto-title', {
            sessionID,
            title: applied,
        });
    };

    /**
     * Closes the window on foreign titles, even during another correction,
     * and serializes eligible corrections within the session's lifetime.
     * @param sessionID session whose title notification arrived
     * @param info title evidence used to decide correction eligibility
     */
    const correctLateAutoTitle = async (
        sessionID: string,
        info: SessionInfo,
    ): Promise<void> => {
        if (disposed || deleted.has(sessionID)) {
            return;
        }
        const applied = state.appliedTitles[sessionID];
        if (!applied || info.title === applied) {
            return;
        }
        const rec = tracked.get(sessionID);
        if (rec?.autoTitle === undefined || info.title !== rec.autoTitle) {
            await forgetAppliedTitle(sessionID);
            return;
        }
        if (correcting.has(sessionID)) {
            return;
        }
        correcting.add(sessionID);
        const signal = signalFor(sessionID);
        await runJob(async () => {
            try {
                signal.throwIfAborted();
                await applyLateAutoTitle(sessionID, info, signal);
            } finally {
                correcting.delete(sessionID);
            }
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
        const patch = classifyTitleChange(rec, info.title ?? '', host.isDefaultTitle);
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
            cancelSession(sessionID);
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
        event: async ({ event }: NamingEventInput) => {
            if (disposed) {
                return;
            }
            let eventSessionID: string | undefined;
            if ('info' in event.properties) {
                const { info } = event.properties;
                eventSessionID = 'sessionID' in info ? info.sessionID : info.id;
            } else {
                eventSessionID = event.properties.sessionID;
            }
            if (eventSessionID && deleted.has(eventSessionID)) {
                return;
            }
            if (event.type === EventType.SessionDeleted) {
                const { id } = event.properties.info;
                if (id) {
                    deleted.add(id);
                    cancelSession(id);
                    tracked.delete(id);
                }
                return;
            }
            if (event.type === EventType.MessageReady) {
                schedule(event.properties.sessionID);
                return;
            }
            try {
                if (event.type === EventType.SessionCreated) {
                    const info = event.properties?.info;
                    if (info?.id) {
                        const rec = recordFor(info.id);
                        if (rec.lastTitle === undefined) {
                            rec.lastTitle = info.title;
                        }
                        rec.directory = info.directory;
                        rec.child = Boolean(info.parentID);
                    }
                    return;
                }
                if (event.type === EventType.SessionUpdated) {
                    await onSessionUpdated(event.properties?.info);
                    return;
                }
                if (event.type === EventType.MessageUpdated) {
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
                        const wasGivenUp = rec.givenUp;
                        if (wasGivenUp) {
                            rec.givenUp = false;
                            rec.renameAttempts = 0;
                            rec.scheduled = false;
                        }
                        if (first || wasGivenUp) {
                            schedule(info.sessionID);
                        }
                    }
                    return;
                }
                if (event.type === EventType.SessionIdle) {
                    const sessionID = event.properties?.sessionID;
                    if (sessionID) {
                        await onSessionIdle(sessionID);
                    }
                }
            } catch {
                log('error', 'event handler failed', {
                    sessionID: eventSessionID,
                    event: event.type,
                });
            }
        },
        dispose: async (): Promise<void> => {
            if (disposed) {
                await Promise.allSettled([...jobs]);
                return;
            }
            disposed = true;
            for (const timer of timers.values()) {
                clearTimeout(timer);
            }
            timers.clear();
            for (const controller of controllers.values()) {
                controller.abort();
            }
            controllers.clear();
            await Promise.allSettled([...jobs]);
            tracked.clear();
            correcting.clear();
            deleted.clear();
        },
    };
};
