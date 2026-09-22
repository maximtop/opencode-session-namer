import type { Plugin } from '@opencode-ai/plugin';
import { createV1Host, v1Event } from './host-v1';
import { createLifecycle } from './lifecycle';

/**
 * Loads the naming lifecycle using the SDK supplied by OpenCode V1.
 * @returns V1 event hooks
 * @param root0 host plugin context
 * @param root0.client injected V1 SDK client
 */
export const SessionNamer: Plugin = async ({ client }) => {
    const host = createV1Host(client);
    const lifecycle = await createLifecycle(host);
    return {
        dispose: lifecycle.dispose,
        event: async ({ event }) => {
            const normalized = v1Event(event);
            if (normalized) {
                await lifecycle.event({ event: normalized });
            }
        },
    };
};
