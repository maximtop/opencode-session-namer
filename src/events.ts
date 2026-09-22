/**
 * Wire event names used by the host adapters and shared naming lifecycle.
 */
export enum EventType {
    /**
     * Session creation on either host.
     */
    SessionCreated = 'session.created',

    /**
     * V1 session update and normalized title notification.
     */
    SessionUpdated = 'session.updated',

    /**
     * Session deletion on either host.
     */
    SessionDeleted = 'session.deleted',

    /**
     * V2 title notification.
     */
    SessionRenamed = 'session.renamed',

    /**
     * A host session becoming idle.
     */
    SessionIdle = 'session.idle',

    /**
     * V1 message update and normalized user interaction.
     */
    MessageUpdated = 'message.updated',

    /**
     * Normalized retry opportunity after message delivery.
     */
    MessageReady = 'message.ready',

    /**
     * A V2 inbox item being queued.
     */
    SessionInboxEnqueued = 'session.inbox.enqueued',

    /**
     * A V2 inbox item becoming available in session context.
     */
    SessionInboxDelivered = 'session.inbox.delivered',
}
