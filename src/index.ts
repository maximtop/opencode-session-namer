import type { Plugin } from '@opencode-ai/plugin';
import { V1Host } from './host-v1';
import { createLifecycle } from './lifecycle';

/**
 * Loads the naming lifecycle using the SDK supplied by OpenCode V1.
 * @returns V1 event hooks
 * @param root0 host plugin context
 * @param root0.client injected V1 SDK client
 */
export const SessionNamer: Plugin = async ({ client }) => {
    const host = new V1Host(client);
    const lifecycle = await createLifecycle(host);
    return {
        dispose: lifecycle.dispose,
        event: async ({ event }) => {
            const normalized = V1Host.normalizeEvent(event);
            if (normalized) {
                await lifecycle.event({ event: normalized });
            }
        },
    };
};
