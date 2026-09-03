import { truncateAtWord } from './text';
import type { PluginClient, PluginConfig } from './types';

/** A "provider/model" pair resolved to its two parts. */
type ModelRef = {
    /** Provider id, e.g. "anthropic". */
    providerID: string;
    /** Model id within the provider, e.g. "claude-haiku-4-5". */
    modelID: string;
};

/**
 * Resolves the model used for shortening: the config override first, then
 * opencode's small_model.
 * @param client opencode SDK client
 * @param config plugin config
 * @returns model reference or undefined (server default then applies)
 */
async function resolveModel(
    client: PluginClient,
    config: PluginConfig,
): Promise<ModelRef | undefined> {
    let ref = config.smartShortenModel;
    if (!ref) {
        const cfg = await client.config.get();
        const small = cfg.data?.small_model;
        ref = typeof small === 'string' ? small : null;
    }
    if (!ref || !ref.includes('/')) {
        return undefined;
    }
    const [providerID, modelID] = ref.split('/');
    if (!providerID || !modelID) {
        return undefined;
    }
    return { providerID, modelID };
}

/**
 * Creates the smartShorten function bound to the SDK client.
 * @param client opencode SDK client
 * @param config plugin config
 * @returns smartShorten implementation
 */
export function createSmartShorten(
    client: PluginClient,
    config: PluginConfig,
) {
    /**
     * LLM-shortens an overlong descriptive part via a throwaway child
     * session. Any failure propagates — the caller falls back to truncation.
     * @param text text to shorten
     * @param budget maximum length of the result
     * @param parentSessionID session the child is attached to
     * @param directory working directory for the child session
     * @returns shortened text
     */
    return async function smartShorten(
        text: string,
        budget: number,
        parentSessionID: string,
        directory: string,
    ): Promise<string> {
        const model = await resolveModel(client, config);
        const child = await client.session.create({
            body: { parentID: parentSessionID, title: 'session-namer: shorten' },
            query: { directory },
        });
        const childID = child.data?.id;
        if (!childID) {
            throw new Error('failed to create shorten session');
        }
        try {
            await client.session.prompt({
                path: { id: childID },
                query: { directory },
                body: {
                    ...(model ? { model } : {}),
                    parts: [{
                        type: 'text',
                        text: [
                            `Shorten the following title to at most ${budget}`,
                            'characters. Keep the same language and the key',
                            'technical terms. Reply with the shortened title',
                            'only — no quotes, no explanations.',
                            '',
                            text,
                        ].join('\n'),
                    }],
                },
            });
            const msgs = await client.session.messages({
                path: { id: childID },
                query: { directory },
            });
            const assistants = (msgs.data ?? [])
                .filter((m) => m.info?.role === 'assistant')
                .sort(
                    (a, b) => (b.info.time?.created ?? 0)
                        - (a.info.time?.created ?? 0),
                );
            let shortened: string | undefined;
            for (const message of assistants) {
                for (const part of message.parts ?? []) {
                    if (part.type === 'text' && part.text.trim()) {
                        shortened = part.text.trim().split('\n')[0]?.trim();
                        break;
                    }
                }
                if (shortened) {
                    break;
                }
            }
            if (!shortened) {
                throw new Error('empty shorten reply');
            }
            return shortened.length > budget + 10
                ? truncateAtWord(shortened, budget)
                : shortened;
        } finally {
            await client.session
                .delete({ path: { id: childID }, query: { directory } })
                .catch(() => {});
        }
    };
}
