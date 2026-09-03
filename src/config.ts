import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { PluginConfig } from './types';

const CONFIG_FILE = process.env.SESSION_NAMER_CONFIG
    ?? join(homedir(), '.config', 'opencode', 'session-namer.json');

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

const delayMsOverride = positiveInt(DEFAULTS.renameDelayMs);

/**
 * Applies the SESSION_NAMER_DELAY_MS env override through the same
 * positive-int coercion as the file keys (garbage, zero and negatives fall
 * back to the default). Test hook.
 * @param config config loaded from the user file and defaults
 * @returns config with the env override applied
 */
function applyEnvOverride(config: PluginConfig): PluginConfig {
    const raw = process.env.SESSION_NAMER_DELAY_MS;
    if (raw === undefined || raw === '') {
        return config;
    }
    return { ...config, renameDelayMs: delayMsOverride.parse(raw) };
}

/**
 * Loads the user config merged over the defaults. A missing or broken file
 * means defaults; per-key type mismatches fall back to that key's default.
 * @returns effective plugin config
 */
export async function loadConfig(): Promise<PluginConfig> {
    let raw: unknown;
    try {
        raw = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
    } catch {
        raw = {};
    }
    let parsed: PluginConfig;
    try {
        parsed = ConfigSchema.parse(raw);
    } catch {
        // the top level is not a plain object (array/scalar) — all defaults
        parsed = ConfigSchema.parse({});
    }
    return applyEnvOverride(parsed);
}
