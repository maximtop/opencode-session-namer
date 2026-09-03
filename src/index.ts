/**
 * opencode-session-namer — gives opencode sessions meaningful names.
 *
 * What it does, once per session, shortly after the first reply settles:
 * - PR link in the first message → [<repo>] [<key>] Review pull/<N> <title>
 * - otherwise, inside a git project → [<project>] [<key>] <auto-title>
 *
 * The issue key (e.g. AG-123) comes from the PR branch/title or the worktree
 * branch — no issue-tracker API calls. Worktrees are detected generically
 * through the `.git` file, so the label is the main repo name and the key
 * comes from the worktree branch. A title set by anything other than the
 * built-in auto-title (manual rename, another tool) marks the session as
 * foreign and it is never renamed. A session is renamed at most once, ever.
 */

import type { Plugin } from '@opencode-ai/plugin';
import { loadConfig } from './config';
import { loadState, saveState } from './state';
import { createRenamer } from './rename';
import { classifyTitleChange } from './tracking';
import type { AgKeyExtractor, LogFn, TrackedSession } from './types';

/**
 * The plugin factory. Loads config and state, wires the renamer and returns
 * the event hook that schedules a one-time rename after the first idle.
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

    const markProcessed = async (
        id: string,
        appliedTitle?: string,
    ): Promise<void> => {
        state.processed[id] = Date.now();
        if (appliedTitle) {
            state.appliedTitles[id] = appliedTitle;
        }
        await saveState(state);
    };

    const releaseScheduled = (id: string): void => {
        const rec = tracked.get(id);
        if (rec) {
            rec.scheduled = false;
        }
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
        if (rec.foreign || rec.scheduled) {
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

    return {
        /**
         * Tracks sessions and schedules the rename. `message.updated` is the
         * fast path (rename right after the first user message — long first
         * turns would otherwise delay the rename until the first idle).
         * `session.updated` tells the built-in auto-title apart from manual
         * renames and corrects a late auto-title write over our title once,
         * before the first idle. `session.idle` is the fallback path for
         * sessions restored before the plugin saw their first message.
         * @param input opencode event envelope
         * @param input.event the event payload
         */
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
                    if (!info?.id) {
                        return;
                    }
                    const applied = state.appliedTitles[info.id];
                    if (state.processed[info.id]) {
                        // a late auto-title write overwrote our title before
                        // the first idle — re-apply ours exactly once
                        if (applied && info.title !== applied) {
                            delete state.appliedTitles[info.id];
                            await saveState(state);
                            await client.session.update({
                                path: { id: info.id },
                                body: { title: applied },
                            });
                            log('info', 'restored title over late auto-title', {
                                sessionID: info.id,
                                title: applied,
                            });
                        }
                        return;
                    }
                    const rec = recordFor(info.id);
                    const patch = classifyTitleChange(rec, info.title);
                    rec.foreign = patch.foreign;
                    rec.autoTitle = patch.autoTitle;
                    rec.lastTitle = patch.lastTitle;
                    return;
                }
                if (event.type === 'message.updated') {
                    const info = event.properties?.info;
                    if (info?.role === 'user' && info.sessionID) {
                        const rec = recordFor(info.sessionID);
                        const first = !rec.sawUserMessage;
                        rec.sawUserMessage = true;
                        if (first) {
                            schedule(info.sessionID);
                        }
                    }
                    return;
                }
                if (event.type === 'session.idle') {
                    const sessionID = event.properties?.sessionID;
                    if (!sessionID) {
                        return;
                    }
                    if (state.processed[sessionID]) {
                        // the re-apply window ends at the first idle after
                        // the rename — drop the tracked record then
                        tracked.delete(sessionID);
                        delete state.appliedTitles[sessionID];
                        await saveState(state);
                        return;
                    }
                    const rec = recordFor(sessionID);
                    if (rec.foreign) {
                        return;
                    }
                    schedule(sessionID);
                }
            } catch (e) {
                log('error', 'event handler failed', {
                    error: String(e),
                    event: event.type,
                });
            }
        },
    };
};
