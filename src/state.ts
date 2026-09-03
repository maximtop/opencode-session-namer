import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { LogFn, State } from './types';

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
 * Drops applied titles whose processed entry is gone (TTL-expired). The
 * correction window only matters for recently processed sessions; without
 * this, stale entries would leak across restarts and could re-clobber a
 * manual title weeks later.
 * @param appliedTitles session id → applied title map
 * @param processed pruned processed map to filter against
 * @returns applied titles that still have a live processed entry
 */
function pruneAppliedTitles(
    appliedTitles: unknown,
    processed: Record<string, number>,
): Record<string, string> {
    const map = (appliedTitles ?? {}) as Record<string, string>;
    return Object.fromEntries(
        Object.entries(map).filter(([id]) => processed[id] !== undefined),
    );
}

/**
 * Loads the processed-session ids, dropping entries older than the TTL.
 * @returns rename-once state
 */
export async function loadState(): Promise<State> {
    try {
        const parsed = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
        const processed = prune(parsed.processed);
        return {
            processed,
            appliedTitles: pruneAppliedTitles(
                parsed.appliedTitles,
                processed,
            ),
        };
    } catch {
        return { processed: {}, appliedTitles: {} };
    }
}

/**
 * Persists the state file atomically (tmp file + rename) so a crash or a
 * concurrent writer cannot leave a torn file. Old entries are pruned on
 * every write so long-running processes do not keep re-saving expired ids.
 * Best effort: failures are logged, never thrown.
 * @param state state to persist
 * @param log optional leveled logger for write failures
 */
export async function saveState(state: State, log?: LogFn): Promise<void> {
    const processed = prune(state.processed);
    const next: State = {
        processed,
        appliedTitles: pruneAppliedTitles(state.appliedTitles, processed),
    };
    const tmp = `${STATE_FILE}.tmp`;
    try {
        await fsp.mkdir(dirname(STATE_FILE), { recursive: true });
        await fsp.writeFile(tmp, JSON.stringify(next));
        await fsp.rename(tmp, STATE_FILE);
    } catch (e) {
        log?.('warn', 'failed to persist session-namer state', {
            error: String(e),
        });
        await fsp.rm(tmp, { force: true }).catch(() => {});
    }
}
