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

    const markProcessed = async (id: string): Promise<void> => {
        state.processed[id] = Date.now();
        tracked.delete(id);
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

    return {
        /**
         * Tracks sessions and schedules the rename. `session.updated`
         * events tell the built-in auto-title apart from manual renames;
         * `session.idle` arms the delayed rename.
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
                    const rec = recordFor(info.id);
                    if (state.processed[info.id]) {
                        return;
                    }
                    const patch = classifyTitleChange(rec, info.title);
                    rec.foreign = patch.foreign;
                    rec.autoTitle = patch.autoTitle;
                    rec.lastTitle = patch.lastTitle;
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
                    if (rec.foreign) {
                        return;
                    }
                    if (!rec.sawUserMessage) {
                        // idle before the first message: wait for a later
                        // idle so the session is not burned unrenamed
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
                            log(
                                'error',
                                'rename failed, will retry on next idle',
                                { sessionID, error: String(e) },
                            );
                            releaseScheduled(sessionID);
                        }
                    }, config.renameDelayMs);
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
