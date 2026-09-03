import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LogFn, PrInfo, PrLink } from './types';

const execFileAsync = promisify(execFile);

/**
 * Hard cap on a gh call: a hung gh (network, auth prompt) must not wedge
 * the rename forever or leak the child process.
 */
const GH_TIMEOUT_MS = 15000;

/**
 * Fetches PR title and head branch via the gh CLI. Only github.com hosts are
 * accepted: GHES hosts are never trusted (gh forward GHES tokens to whatever
 * GH_HOST names, so a link from an untrusted message could exfiltrate them).
 * @param pr parsed PR link
 * @param log leveled logger
 * @returns PR info or null on any failure
 */
export async function fetchGhPrInfo(
    pr: PrLink,
    log: LogFn,
): Promise<PrInfo | null> {
    if (pr.host !== 'https://github.com') {
        log('warn', 'unsupported PR host, naming from URL only', {
            host: pr.host,
            repo: `${pr.owner}/${pr.repo}`,
            number: pr.number,
        });
        return null;
    }
    const args = [
        'pr', 'view', pr.number,
        '--repo', `${pr.owner}/${pr.repo}`,
        '--json', 'title,headRefName',
    ];
    try {
        const { stdout } = await execFileAsync('gh', args, {
            timeout: GH_TIMEOUT_MS,
        });
        // external boundary: validate the shape instead of trusting it
        const parsed: unknown = JSON.parse(stdout);
        const obj = (parsed ?? {}) as Record<string, unknown>;
        return {
            title: typeof obj.title === 'string' ? obj.title : null,
            branch: typeof obj.headRefName === 'string'
                ? obj.headRefName
                : null,
        };
    } catch (e) {
        log('warn', 'gh PR fetch failed, naming from URL only', {
            repo: `${pr.owner}/${pr.repo}`,
            number: pr.number,
            error: String(e),
        });
        return null;
    }
}
