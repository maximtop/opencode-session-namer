import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { State } from './types';

const STATE_FILE = process.env.SESSION_NAMER_STATE
    ?? join(homedir(), '.config', 'opencode', 'session-namer.state.json');
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Drops entries older than the TTL.
 * @param processed session id → processed timestamp map
 * @returns pruned copy
 */
function prune(processed: unknown): Record<string, number> {
    const map = (processed ?? {}) as Record<string, number>;
    const now = Date.now();
    const entries = Object.entries(map)
        .filter(([, ts]) => now - ts < STATE_TTL_MS);
    return Object.fromEntries(entries);
}

/**
 * Loads the processed-session ids, dropping entries older than the TTL.
 * @returns rename-once state
 */
export async function loadState(): Promise<State> {
    try {
        const parsed = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
        return { processed: prune(parsed.processed) };
    } catch {
        return { processed: {} };
    }
}

/**
 * Persists the state file (best effort). Old entries are pruned on every
 * write so long-running processes do not keep re-saving expired ids.
 * @param state state to persist
 */
export async function saveState(state: State): Promise<void> {
    try {
        const next = { ...state, processed: prune(state.processed) };
        await fsp.mkdir(dirname(STATE_FILE), { recursive: true });
        await fsp.writeFile(STATE_FILE, JSON.stringify(next));
    } catch {
        // best effort
    }
}
