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

import type { Plugin } from '@opencode-ai/plugin';
import { loadConfig } from './config';
import { loadState, saveState } from './state';
import { createRenamer } from './rename';
import type { AgKeyExtractor, TrackedSession } from './types';

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
    const extractAgKey: AgKeyExtractor = (text) => {
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

    const rename = createRenamer({
        client,
        config,
        extractAgKey,
        log,
        state,
        tracked,
        markProcessed,
    });

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
                        rename(sessionID).catch((e) => log(
                            'error',
                            'rename failed',
                            { sessionID, error: String(e) },
                        ));
                    }, config.renameDelayMs);
                }
            } catch (e) {
                log('error', 'event handler failed', { error: String(e) });
            }
        },
    };
};
