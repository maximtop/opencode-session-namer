/**
 * Upper bound for transient session ownership and replay evidence.
 * Persistent rename history is managed separately by the state module.
 */
export const MAX_RECENT_SESSIONS = 1024;

/**
 * Retains recent session evidence without growing with server uptime.
 * @param cache instance-owned cache, ordered from least recently observed
 * @param sessionID session whose evidence is refreshed
 * @param value current ownership, revision or deletion evidence
 */
export function rememberSession<Value>(
    cache: Map<string, Value>,
    sessionID: string,
    value: Value,
): void {
    cache.delete(sessionID);
    cache.set(sessionID, value);
    if (cache.size > MAX_RECENT_SESSIONS) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
            cache.delete(oldest);
        }
    }
}
