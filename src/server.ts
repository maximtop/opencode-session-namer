import type { Plugin } from '@opencode/plugin';
import { SessionNamer } from './index';

export default {
    id: 'session-namer',
    server: SessionNamer,
    setup: async (ctx: Plugin.Context) => {
        const { V2Host } = await import('./host-v2');
        return new V2Host(ctx).setup();
    },
} satisfies Plugin.Plugin & {
    /**
     * Legacy factory selected by V1 hosts resolving the server entry.
     */
    server: typeof SessionNamer;
};
