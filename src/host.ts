import type { EventType } from './events';
import type { LogFn, SessionInfo } from './types';

/**
 * Identifies a session and the lifetime of one operation.
 */
export interface SessionScope {
    /**
     * Host session identifier.
     */
    sessionID: string;

    /**
     * Session directory, when already known from an event.
     */
    directory?: string;

    /**
     * Cancellation of pending reads, generation and title writes.
     */
    signal?: AbortSignal;
}

/**
 * Complete session data required for naming.
 */
export interface NamingSession extends SessionInfo {
    /**
     * Host session identifier.
     */
    id: string;

    /**
     * Empty when the host has not assigned a title.
     */
    title: string;

    /**
     * Actual session directory.
     */
    directory: string;
}

/**
 * Original user-message evidence without guessing through compaction.
 */
export type FirstUserText =
    | {
        /**
         * Original user text is available.
         */
        kind: 'text';

        /**
         * Text of the earliest genuine user message.
         */
        text: string;
    }
    | {
        /**
         * No textual user message has been delivered yet.
         */
        kind: 'empty';
    }
    | {
        /**
         * Compaction has removed the original message.
         */
        kind: 'unavailable';
    };

/**
 * Host-independent text-only generation request.
 */
export interface TextRequest extends SessionScope {
    /**
     * Stable helper title used only by V1 child sessions.
     */
    title: string;

    /**
     * Fixed instructions separate from source text in V1.
     */
    system: string;

    /**
     * Task instructions, including output format and length constraints.
     */
    instructions: string;

    /**
     * Untrusted source text, encoded separately from task instructions.
     */
    data: string;

    /**
     * Explicit provider/model setting, or host default selection.
     */
    model: string | null;
}

/**
 * Narrow integration boundary shared by both host generations.
 */
export interface NamingHost {
    /**
     * Writes operational diagnostics without credentials or prompt text.
     */
    log: LogFn;

    /**
     * Recognizes only this host's unassigned/default title.
     */
    isDefaultTitle: (title: string) => boolean;

    /**
     * Reads current session data; missing data remains retryable.
     */
    getSession: (scope: SessionScope) => Promise<NamingSession | undefined>;

    /**
     * Finds original non-synthetic user text or an explicit skip reason.
     */
    firstUserText: (scope: SessionScope) => Promise<FirstUserText>;

    /**
     * Reports whether the requested title write succeeded.
     */
    updateTitle: (scope: SessionScope, title: string) => Promise<boolean>;

    /**
     * Generates text without allowing tools or modifying the main chat.
     */
    generateText: (request: TextRequest) => Promise<string>;
}

/**
 * Events consumed by the shared lifecycle; adapters discard other events.
 */
export type NamingEvent =
    | {
        /**
         * Session lifecycle notification.
         */
        type: `${EventType.SessionCreated | EventType.SessionUpdated
        | EventType.SessionDeleted}`;

        /**
         * Session fields supplied by the host.
         */
        properties: {
            /**
             * A partial session snapshot.
             */
            info: SessionInfo;
        };
    }
    | {
        /**
         * A genuine user interaction.
         */
        type: `${EventType.MessageUpdated}`;

        /**
         * Message provenance supplied by the host.
         */
        properties: {
            /**
             * User message ownership.
             */
            info: {
                /**
                 * Owning session identifier.
                 */
                sessionID: string;

                /**
                 * Only genuine user messages are normalized.
                 */
                role: 'user';
            };
        };
    }
    | {
        /**
         * A retry opportunity after message delivery or turn completion.
         */
        type: `${EventType.SessionIdle | EventType.MessageReady}`;

        /**
         * Owning session.
         */
        properties: {
            /**
             * Session identifier.
             */
            sessionID: string;
        };
    };

/**
 * Extracts session ownership from a normalized event.
 * @param event notification consumed by the naming lifecycle
 * @returns session identifier when supplied by the host
 */
export function getEventSessionID(event: NamingEvent): string | undefined {
    if ('info' in event.properties) {
        const { info } = event.properties;
        return 'sessionID' in info ? info.sessionID : info.id;
    }
    return event.properties.sessionID;
}

/**
 * Keeps task instructions outside the encoded, untrusted source text.
 * @param request fixed task instructions and source data
 * @returns prompt body shared by both host integrations
 */
export function textPrompt(request: TextRequest): string {
    return `${request.instructions}\n\nInput JSON string:\n${
        JSON.stringify(request.data)}`;
}

/**
 * Parses a configured provider/model without losing slashes in model IDs.
 * @returns model reference or undefined
 * @param ref configured provider/model identifier
 */
export function parseModel(ref: string | null | undefined) {
    const separator = ref?.indexOf('/') ?? -1;
    if (!ref || separator <= 0 || separator === ref.length - 1) {
        return undefined;
    }
    return {
        providerID: ref.slice(0, separator),
        modelID: ref.slice(separator + 1),
    };
}
