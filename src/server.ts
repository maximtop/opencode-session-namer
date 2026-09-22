import type { Plugin } from '@opencode/plugin';
import { SessionNamer } from './index';

export default {
    id: 'session-namer',
    server: SessionNamer,
    setup: async (ctx: Plugin.Context) => {
        const { setupV2 } = await import('./host-v2');
        return setupV2(ctx);
    },
} satisfies Plugin.Plugin & {
    /**
     * Legacy factory selected by V1 hosts resolving the server entry.
     */
    server: typeof SessionNamer;
};
