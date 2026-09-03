import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const CONFIG_FILE = process.env.SESSION_NAMER_CONFIG
    ?? join(homedir(), '.config', 'opencode', 'session-namer.json');

const DEFAULTS = {
    template: '[{project}] {agKey} {title}',
    prPrefix: 'Review pull/{number} ',
    agKeyPattern: '[A-Z][A-Z0-9]{1,9}-\\d+',
    maxLength: 90,
    smartShorten: false,
    smartShortenModel: null as string | null,
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
    template: z.string().catch(DEFAULTS.template),
    prPrefix: z.string().catch(DEFAULTS.prPrefix),
    agKeyPattern: z.string().catch(DEFAULTS.agKeyPattern),
    maxLength: positiveInt(DEFAULTS.maxLength),
    smartShorten: z.boolean().catch(DEFAULTS.smartShorten),
    smartShortenModel: z.string().nullable().catch(DEFAULTS.smartShortenModel),
    prLinkLlm: z.boolean().catch(DEFAULTS.prLinkLlm),
    renameDelayMs: positiveInt(DEFAULTS.renameDelayMs),
});

/**
 * Effective plugin configuration (user file merged over the defaults),
 * inferred from the validation schema so the shape lives in one place.
 */
export type PluginConfig = z.infer<typeof ConfigSchema>;

/**
 * Applies the SESSION_NAMER_DELAY_MS env override (non-negative number,
 * defaults on garbage). Test hook.
 * @param config config loaded from the user file and defaults
 * @returns config with the env override applied
 */
function applyEnvOverride(config: PluginConfig): PluginConfig {
    const raw = process.env.SESSION_NAMER_DELAY_MS;
    if (raw === undefined || raw === '') {
        return config;
    }
    const num = Number(raw);
    if (Number.isFinite(num) && num >= 0) {
        return { ...config, renameDelayMs: num };
    }
    return config;
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
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw
        : {};
    return applyEnvOverride(ConfigSchema.parse(obj));
}
