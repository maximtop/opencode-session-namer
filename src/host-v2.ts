import type { Plugin } from '@opencode/plugin';
import { EventType } from './events';
import { getEventSessionID, parseModel, textPrompt } from './host';
import { createLifecycle } from './lifecycle';
import { rememberSession } from './session-cache';
import type { NamingHost, NamingEvent } from './host';

/**
 * An event decoded by OpenCode's public event stream.
 */
type V2Event = ReturnType<Plugin.Context['event']['subscribe']> extends
AsyncIterable<infer Event> ? Event : never;

/**
 * Location fields shared by public sessions and event notifications.
 */
interface EventLocation {
    /**
     * Absolute directory supplied by the public host API.
     */
    directory: string;

    /**
     * Workspace identity, when present on a durable event.
     */
    workspaceID?: string;
}

/**
 * Uses the V2 plugin context without creating an extra network client.
 * @param ctx injected V2 plugin context
 * @returns host operations
 */
export function createV2Host(ctx: Plugin.Context): NamingHost {
    return {
        log: (level, message, extra) => {
            const line = JSON.stringify({
                service: 'session-namer',
                level,
                message,
                sessionID: extra?.sessionID,
            });
            process.stderr.write(`${line}\n`, () => {});
        },
        isDefaultTitle: (title) => title === '',
        getSession: async ({ sessionID, signal }) => {
            signal?.throwIfAborted();
            const session = await ctx.session.get({ sessionID }, { signal });
            return {
                id: session.id,
                title: session.title ?? '',
                directory: session.location.directory,
                parentID: session.parentID,
            };
        },
        firstUserText: async ({ sessionID, signal }) => {
            signal?.throwIfAborted();
            const messages = await ctx.session.context(
                { sessionID },
                { signal },
            );
            if (messages.some((message) => message.type === 'compaction'
                && message.status === 'completed')) {
                return { kind: 'unavailable' };
            }
            const ordered = [...messages].sort(
                (a, b) => a.time.created - b.time.created,
            );
            for (const message of ordered) {
                if (message.type === 'user' && message.text.trim()) {
                    return { kind: 'text', text: message.text };
                }
            }
            return { kind: 'empty' };
        },
        updateTitle: async ({ sessionID, signal }, title) => {
            signal?.throwIfAborted();
            try {
                await ctx.session.update({ sessionID, title }, { signal });
                return true;
            } catch {
                signal?.throwIfAborted();
                return false;
            }
        },
        generateText: async (request) => {
            request.signal?.throwIfAborted();
            const parsed = parseModel(request.model);
            const result = await ctx.generate.text({
                prompt: `${request.system}\n\n${textPrompt(request)}`,
                ...(parsed ? { model: {
                    providerID: parsed.providerID, id: parsed.modelID,
                } } : {}),
            }, { signal: request.signal });
            if (!result.text.trim()) {
                throw new Error('Empty helper reply');
            }
            return result.text;
        },
    };
}

/**
 * Maps durable V2 user/session events without fabricating message text.
 * @param event decoded V2 event
 * @returns normalized event or undefined
 */
export function v2Event(event: V2Event): NamingEvent | undefined {
    switch (event.type) {
        case EventType.SessionCreated:
            return {
                type: EventType.SessionCreated,
                properties: { info: {
                    id: event.data.sessionID,
                    title: event.data.title ?? '',
                    directory: event.data.location.directory,
                    parentID: event.data.parentID,
                } },
            };
        case EventType.SessionRenamed:
            return {
                type: EventType.SessionUpdated,
                properties: { info: {
                    id: event.data.sessionID,
                    title: event.data.title,
                    directory: event.location?.directory,
                } },
            };
        case EventType.SessionDeleted:
            return {
                type: EventType.SessionDeleted,
                properties: { info: { id: event.data.sessionID } },
            };
        case EventType.SessionInboxEnqueued:
            if (event.data.item.type !== 'user') {
                return undefined;
            }
            return {
                type: EventType.MessageUpdated,
                properties: { info: {
                    role: 'user', sessionID: event.data.sessionID,
                } },
            };
        case EventType.SessionInboxDelivered:
            return {
                type: EventType.MessageReady,
                properties: { sessionID: event.data.sessionID },
            };
        case EventType.SessionIdle:
            return {
                type: EventType.SessionIdle,
                properties: { sessionID: event.data.sessionID },
            };
        default:
            return undefined;
    }
}

/**
 * Owns one V2 event subscription and releases all naming work on unload.
 * @param ctx injected V2 plugin context
 * @returns asynchronous cleanup
 */
export async function setupV2(
    ctx: Plugin.Context,
): Promise<() => Promise<void>> {
    const host = createV2Host(ctx);
    const lifecycle = await createLifecycle(host);
    const controller = new AbortController();
    const knownSessions = new Map<string, number | undefined>();
    const stream = ctx.event.subscribe({ signal: controller.signal });
    const pump = (async () => {
        try {
            for await (const event of stream) {
                if (controller.signal.aborted) {
                    break;
                }
                const normalized = v2Event(event);
                if (!normalized) {
                    continue;
                }
                const id = getEventSessionID(normalized);
                if (!id) {
                    continue;
                }
                let location: EventLocation | undefined = 'location' in event ? event.location : undefined;
                if (!location && event.type === EventType.SessionCreated) {
                    location = event.data.location;
                }
                if (!location && !knownSessions.has(id)
                    && event.type !== EventType.SessionDeleted) {
                    try {
                        const session = await ctx.session.get(
                            { sessionID: id },
                            { signal: controller.signal },
                        );
                        location = session.location;
                    } catch {
                        continue;
                    }
                }
                const matches = location
                    ? location.directory === ctx.location.directory
                        && location.workspaceID === ctx.location.workspaceID
                    : knownSessions.has(id);
                if (!matches) {
                    continue;
                }
                const sequence = 'durable' in event
                    ? event.durable.seq : undefined;
                if (sequence !== undefined) {
                    if (sequence <= (knownSessions.get(id) ?? -1)) {
                        continue;
                    }
                }
                rememberSession(
                    knownSessions,
                    id,
                    sequence ?? knownSessions.get(id),
                );
                // Start events in stream order without blocking newer title
                // or cancellation evidence on a pending correction read.
                // The lifecycle owns and drains its asynchronous title work.
                lifecycle.event({ event: normalized }).catch(() => {
                    if (!controller.signal.aborted) {
                        host.log('error', 'V2 event handling failed');
                    }
                });
            }
        } catch {
            if (!controller.signal.aborted) {
                host.log('error', 'V2 event subscription failed');
            }
        }
    })();
    return async () => {
        controller.abort();
        await lifecycle.dispose();
        await pump;
        knownSessions.clear();
    };
}
