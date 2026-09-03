import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { LogFn, State } from './types';

const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The state file path, resolved at call time — the module must not capture
 * env at import (tests and other servers set SESSION_NAMER_STATE per run).
 * @returns state file path
 */
function stateFile(): string {
    return process.env.SESSION_NAMER_STATE
        ?? join(homedir(), '.config', 'opencode', 'session-namer.state.json');
}

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
 * Monotonic counter for tmp names — concurrent saveState writers (several
 * opencode servers, or overlapping rename/idle handlers in one process)
 * must never share one tmp path.
 */
let tmpSeq = 0;

/**
 * Loads the processed-session ids, dropping entries older than the TTL. A
 * missing file is a normal first run (silent); an unreadable or corrupt
 * file is real data loss and is logged.
 * @param log optional leveled logger for load failures
 * @returns rename-once state
 */
export async function loadState(log?: LogFn): Promise<State> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await fsp.readFile(stateFile(), 'utf8'));
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            log?.('warn', 'session-namer state unreadable, starting fresh', {
                error: String(e),
            });
        }
        return { processed: {}, appliedTitles: {} };
    }
    const processed = prune((parsed as Record<string, unknown>)?.processed);
    return {
        processed,
        appliedTitles: pruneAppliedTitles(
            (parsed as Record<string, unknown>)?.appliedTitles,
            processed,
        ),
    };
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
    tmpSeq += 1;
    const tmp = `${stateFile()}.${process.pid}.${tmpSeq}.tmp`;
    // A crash between the tmp write and the rename leaves an orphaned tmp
    // file behind. Deliberately not swept: a sweep could delete another
    // live process's in-flight tmp, which is worse than a stale leftover.
    try {
        await fsp.mkdir(dirname(stateFile()), { recursive: true });
        await fsp.writeFile(tmp, JSON.stringify(next));
        await fsp.rename(tmp, stateFile());
    } catch (e) {
        log?.('warn', 'failed to persist session-namer state', {
            error: String(e),
        });
        await fsp.rm(tmp, { force: true }).catch(() => {});
    }
}
