import type { Plugin } from '@opencode-ai/plugin';
import { EventType } from './events';
import { messageText } from './messages';
import { DEFAULT_TITLE_RE } from './tracking';
import type {
    NamingHost, NamingEvent, TextRequest, SessionScope,
    NamingSession, FirstUserText,
} from './host';
import type { PluginClient } from './types';

import { HostProtocol } from './host';

/**
 * Adapts the V1 SDK and owns disposable helper-session operations.
 */
export class V1Host implements NamingHost {
    /**
     * Tool lockdown for throwaway child sessions: the prompted text comes from
     * external content (PR titles, user messages), so the child must run as a
     * pure text-in/text-out call — every known tool disabled, with a `*`
     * wildcard for server versions that honor it.
     */
    private static readonly CHILD_TOOLS_DISABLED: Record<string, boolean> = {
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
     * Recognizes the host's unassigned title without instance state.
     * @param title current session title
     * @returns whether the title is a V1 default
     */
    static isDefaultTitle(title: string): boolean {
        return DEFAULT_TITLE_RE.test(title);
    }

    readonly isDefaultTitle = V1Host.isDefaultTitle;

    /**
     * Keeps logging bound when passed to lifecycle and integration helpers.
     * @param level diagnostic severity
     * @param message diagnostic message
     * @param extra optional structured context
     */
    readonly log: NamingHost['log'] = (level, message, extra) => {
        this.client.app.log({
            body: { service: 'session-namer', level, message, extra },
        }).catch(() => {});
    };

    /**
     * Receives the SDK without changing host configuration or storage.
     * @param client injected V1 SDK client
     */
    constructor(private readonly client: PluginClient) {}

    /**
     * Reads the current session snapshot.
     * @param scope session identity and cancellation
     * @returns session data, or undefined when missing
     */
    async getSession(scope: SessionScope): Promise<NamingSession | undefined> {
        const { sessionID, directory, signal } = scope;
        signal?.throwIfAborted();
        const result = await this.client.session.get({
            path: { id: sessionID }, query: { directory }, signal,
        });
        if (result.error) {
            throw new Error('V1 session read failed');
        }
        return result.data ? { ...result.data } : undefined;
    }

    /**
     * Finds the first user message in the session history.
     * @param scope session identity and cancellation
     * @returns original text or an empty result
     */
    async firstUserText(scope: SessionScope): Promise<FirstUserText> {
        const { sessionID, directory, signal } = scope;
        signal?.throwIfAborted();
        const result = await this.client.session.messages({
            path: { id: sessionID }, query: { directory }, signal,
        });
        if (result.error) {
            throw new Error('V1 message read failed');
        }
        const text = messageText(result.data ?? [], 'user', 'first');
        return text ? { kind: 'text', text } : { kind: 'empty' };
    }

    /**
     * Writes a session title through the V1 SDK.
     * @param scope session identity and cancellation
     * @param title new session title
     * @returns whether the write succeeded
     */
    async updateTitle(scope: SessionScope, title: string): Promise<boolean> {
        const { sessionID, directory, signal } = scope;
        signal?.throwIfAborted();
        const result = await this.client.session.update({
            path: { id: sessionID },
            query: { directory },
            body: { title },
            signal,
        });
        return !result.error;
    }

    /**
     * Runs a pure text request in a disposable V1 child session.
     * @param request text request and cancellation scope
     * @returns generated text
     */
    async generateText(request: TextRequest): Promise<string> {
        const { sessionID, directory, signal } = request;
        signal?.throwIfAborted();
        let ref = request.model;
        if (!ref) {
            try {
                const config = await this.client.config.get({
                    query: { directory }, signal,
                });
                ref = config.error ? null : config.data?.small_model ?? null;
            } catch {
                ref = null;
            }
        }
        signal?.throwIfAborted();
        const model = HostProtocol.parseModel(ref);
        // Let creation settle so an allocated child ID is not lost on abort.
        const child = await this.client.session.create({
            body: { parentID: sessionID, title: request.title },
            query: { directory },
        });
        const childID = child.data?.id;
        if (!childID || child.error) {
            throw new Error('V1 helper creation failed');
        }
        try {
            signal?.throwIfAborted();
            const response = await this.client.session.prompt({
                path: { id: childID },
                query: { directory },
                signal,
                body: {
                    ...(model ? { model } : {}),
                    system: request.system,
                    tools: V1Host.CHILD_TOOLS_DISABLED,
                    parts: [{
                        type: 'text', text: HostProtocol.textPrompt(request),
                    }],
                },
            });
            if (response.error) {
                throw new Error('V1 helper prompt failed');
            }
            const messages = await this.client.session.messages({
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
                const removed = await this.client.session.delete({
                    path: { id: childID },
                    query: { directory },
                    signal: AbortSignal.timeout(5000),
                });
                if (removed.error) {
                    this.log('warn', 'failed to delete helper child session', {
                        sessionID: childID,
                    });
                }
            } catch {
                this.log('warn', 'failed to delete helper child session', {
                    sessionID: childID,
                });
            }
        }
    }

    /**
     * Converts only events needed for session naming.
     * @returns normalized event or undefined
     * @param event decoded host event
     */
    static normalizeEvent(
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
}
