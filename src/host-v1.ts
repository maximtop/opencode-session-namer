import type { Plugin } from '@opencode-ai/plugin';
import { EventType } from './events';
import { messageText } from './messages';
import { DEFAULT_TITLE_RE } from './tracking';
import type { NamingHost, NamingEvent, TextRequest } from './host';
import type { PluginClient } from './types';

import { parseModel } from './host';

/**
 * Tool lockdown for throwaway child sessions: the prompted text comes from
 * external content (PR titles, user messages), so the child must run as a
 * pure text-in/text-out call — every known tool disabled, with a `*`
 * wildcard for server versions that honor it.
 */
const CHILD_TOOLS_DISABLED: Record<string, boolean> = {
    '*': false,
    bash: false,
    edit: false,
    write: false,
    patch: false,
    webfetch: false,
    websearch: false,
    task: false,
    skill: false,
    question: false,
    todowrite: false,
};

/**
 * Runs a pure text request in a disposable V1 child session.
 * @returns generated text
 * @param client injected V1 SDK client
 * @param request text request and cancellation scope
 * @param log operational diagnostics
 */
async function generateV1Text(
    client: PluginClient,
    request: TextRequest,
    log: NamingHost['log'],
): Promise<string> {
    const { sessionID, directory, signal } = request;
    signal?.throwIfAborted();
    let ref = request.model;
    if (!ref) {
        const config = await client.config.get({
            query: { directory }, signal,
        });
        if (config.error) {
            throw new Error('V1 model configuration read failed');
        }
        ref = config.data?.small_model ?? null;
    }
    signal?.throwIfAborted();
    const model = parseModel(ref);
    // Let creation settle so an allocated child ID is not lost on abort.
    const child = await client.session.create({
        body: { parentID: sessionID, title: request.title },
        query: { directory },
    });
    const childID = child.data?.id;
    if (!childID || child.error) {
        throw new Error('V1 helper creation failed');
    }
    try {
        signal?.throwIfAborted();
        const response = await client.session.prompt({
            path: { id: childID },
            query: { directory },
            signal,
            body: {
                ...(model ? { model } : {}),
                system: request.system,
                tools: CHILD_TOOLS_DISABLED,
                parts: [{ type: 'text', text: request.prompt }],
            },
        });
        if (response.error) {
            throw new Error('V1 helper prompt failed');
        }
        const messages = await client.session.messages({
            path: { id: childID }, query: { directory }, signal,
        });
        if (messages.error) {
            throw new Error('V1 helper response read failed');
        }
        const text = messageText(messages.data ?? [], 'assistant', 'newest');
        if (!text?.trim()) {
            throw new Error('Empty helper reply');
        }
        return text;
    } finally {
        try {
            const removed = await client.session.delete({
                path: { id: childID },
                query: { directory },
                signal: AbortSignal.timeout(5000),
            });
            if (removed.error) {
                log('warn', 'failed to delete helper child session', {
                    sessionID: childID,
                });
            }
        } catch {
            log('warn', 'failed to delete helper child session', {
                sessionID: childID,
            });
        }
    }
}

/**
 * Adapts the V1 SDK without changing its configuration or storage.
 * @returns host operations
 * @param client injected V1 SDK client
 */
export function createV1Host(client: PluginClient): NamingHost {
    const log: NamingHost['log'] = (level, message, extra) => {
        client.app.log({
            body: { service: 'session-namer', level, message, extra },
        }).catch(() => {});
    };
    return {
        log,
        isDefaultTitle: (title) => DEFAULT_TITLE_RE.test(title),
        getSession: async ({ sessionID, directory, signal }) => {
            signal?.throwIfAborted();
            const result = await client.session.get({
                path: { id: sessionID }, query: { directory }, signal,
            });
            if (result.error) {
                throw new Error('V1 session read failed');
            }
            return result.data ? { ...result.data } : undefined;
        },
        firstUserText: async ({ sessionID, directory, signal }) => {
            signal?.throwIfAborted();
            const result = await client.session.messages({
                path: { id: sessionID }, query: { directory }, signal,
            });
            if (result.error) {
                throw new Error('V1 message read failed');
            }
            const text = messageText(result.data ?? [], 'user', 'first');
            return text ? { kind: 'text', text } : { kind: 'empty' };
        },
        updateTitle: async ({ sessionID, directory, signal }, title) => {
            signal?.throwIfAborted();
            const result = await client.session.update({
                path: { id: sessionID },
                query: { directory },
                body: { title },
                signal,
            });
            return !result.error;
        },
        generateText: (request) => generateV1Text(client, request, log),
    };
}

/**
 * Converts only events needed for session naming.
 * @returns normalized event or undefined
 * @param event decoded host event
 */
export function v1Event(
    event: Parameters<NonNullable<
    Awaited<ReturnType<Plugin>>['event']
    >>[0]['event'],
): NamingEvent | undefined {
    switch (event.type) {
        case EventType.SessionCreated:
        case EventType.SessionUpdated:
        case EventType.SessionDeleted:
            return {
                type: event.type,
                properties: { info: event.properties.info },
            };
        case EventType.MessageUpdated:
            if (event.properties.info.role !== 'user') {
                return undefined;
            }
            return {
                type: EventType.MessageUpdated,
                properties: { info: {
                    role: 'user', sessionID: event.properties.info.sessionID,
                } },
            };
        case EventType.SessionIdle:
            return { type: event.type, properties: event.properties };
        default:
            return undefined;
    }
}
