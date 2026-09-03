import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { PluginConfig } from './types';

/**
 * The default config path, resolved at call time so tests (and any consumer
 * that sets the env var after import) get the expected file.
 * @returns config file path
 */
function defaultConfigPath(): string {
    return join(
        homedir(),
        '.config',
        'opencode',
        'session-namer.json',
    );
}

const DEFAULTS: PluginConfig = {
    template: '[{project}] {agKey} {title}',
    prPrefix: 'Review pull/{number} ',
    agKeyPattern: '[A-Z][A-Z0-9]{1,9}-\\d+',
    maxLength: 90,
    smartShorten: false,
    smartShortenModel: null,
    prLinkLlm: false,
    renameDelayMs: 10000,
};

/**
 * A positive-integer config field that also accepts a numeric string.
 * Anything else — booleans, null, objects, out-of-range values — falls back
 * to `fallback`, so a single mistyped key never breaks the whole config.
 * @param fallback default used when the raw value is unusable
 * @returns schema that always yields a positive integer
 */
function positiveInt(fallback: number) {
    return z
        .preprocess(
            (value) => (typeof value === 'number' || typeof value === 'string'
                ? value
                : Number.NaN),
            z.coerce.number().int().positive(),
        )
        .catch(fallback);
}

const ConfigSchema = z.object({
    template: z.string().min(1).catch(DEFAULTS.template),
    prPrefix: z.string().catch(DEFAULTS.prPrefix),
    agKeyPattern: z.string().min(1).catch(DEFAULTS.agKeyPattern),
    maxLength: positiveInt(DEFAULTS.maxLength),
    smartShorten: z.boolean().catch(DEFAULTS.smartShorten),
    smartShortenModel: z.string().nullable().catch(DEFAULTS.smartShortenModel),
    prLinkLlm: z.boolean().catch(DEFAULTS.prLinkLlm),
    renameDelayMs: positiveInt(DEFAULTS.renameDelayMs),
});

// loadConfig assigns the schema output to a PluginConfig-typed variable, so
// the schema shape drifting from the type in types.ts fails type-check.

/**
 * Loads the user config merged over the defaults. A missing or broken file
 * means defaults; per-key type mismatches fall back to that key's default.
 * The SESSION_NAMER_DELAY_MS override is folded into the raw object before
 * parsing, so it goes through the same positive-int validation as the file
 * keys (zero, negatives and garbage fall back to the default).
 * @param file config path; defaults to the env override or the user config
 * @returns effective plugin config
 */
export async function loadConfig(
    file = process.env.SESSION_NAMER_CONFIG ?? defaultConfigPath(),
): Promise<PluginConfig> {
    let raw: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            raw = { ...(parsed as Record<string, unknown>) };
        }
    } catch {
        raw = {};
    }
    const envRaw = process.env.SESSION_NAMER_DELAY_MS;
    if (envRaw !== undefined && envRaw !== '') {
        raw.renameDelayMs = envRaw;
    }
    return ConfigSchema.parse(raw);
}
