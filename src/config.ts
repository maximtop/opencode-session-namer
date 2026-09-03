import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
    renameDelayMs: 10000,
};

const NUMBER_KEYS = ['maxLength', 'renameDelayMs'];
const BOOL_KEYS = ['smartShorten'];
const STRING_KEYS = ['template', 'prPrefix', 'agKeyPattern', 'smartShortenModel'];

/**
 * Normalizes one raw config value against the known key set: unknown keys
 * are dropped, mistyped values fall back to the default per key.
 * @param key config key
 * @param value raw value from the user file
 * @returns coerced value or undefined for unknown keys
 */
function coerceValue(key: string, value: unknown): unknown {
    if (NUMBER_KEYS.includes(key)) {
        const num = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(num) && num > 0
            ? num
            : DEFAULTS[key as keyof PluginConfig];
    }
    if (BOOL_KEYS.includes(key)) {
        return typeof value === 'boolean'
            ? value
            : DEFAULTS[key as keyof PluginConfig];
    }
    if (STRING_KEYS.includes(key)) {
        return typeof value === 'string'
            ? value
            : DEFAULTS[key as keyof PluginConfig];
    }
    return undefined;
}

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
    let raw: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            raw = parsed as Record<string, unknown>;
        }
    } catch {
        // broken file means defaults
    }
    const config = { ...DEFAULTS };
    for (const [key, value] of Object.entries(raw)) {
        const coerced = coerceValue(key, value);
        if (coerced !== undefined) {
            (config as unknown as Record<string, unknown>)[key] = coerced;
        }
    }
    return applyEnvOverride(config);
}
