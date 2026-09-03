import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { State } from './types';

const STATE_FILE = process.env.SESSION_NAMER_STATE
    ?? join(homedir(), '.config', 'opencode', 'session-namer.state.json');
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Loads the processed-session ids, dropping entries older than the TTL.
 * @returns rename-once state
 */
export async function loadState(): Promise<State> {
    try {
        const parsed = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
        const now = Date.now();
        const processed = (parsed.processed ?? {}) as Record<string, number>;
        const entries = Object.entries(processed)
            .filter(([, ts]) => now - ts < STATE_TTL_MS);
        return { processed: Object.fromEntries(entries) };
    } catch {
        return { processed: {} };
    }
}

/**
 * Persists the state file (best effort — a failed write only means a
 * session could be re-evaluated after a restart).
 * @param state state to persist
 */
export async function saveState(state: State): Promise<void> {
    try {
        await fsp.mkdir(dirname(STATE_FILE), { recursive: true });
        await fsp.writeFile(STATE_FILE, JSON.stringify(state));
    } catch {
        // best effort
    }
}
