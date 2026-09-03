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

/**
 * Loads the user config merged over the defaults. A missing or broken file
 * means defaults.
 * @returns effective plugin config
 */
export async function loadConfig(): Promise<PluginConfig> {
    try {
        const raw = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
        return { ...DEFAULTS, ...raw };
    } catch {
        return { ...DEFAULTS };
    }
}
