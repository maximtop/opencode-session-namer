import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrInfo, PrLink } from './types';

const execFileAsync = promisify(execFile);

/**
 * Fetches PR title and head branch via the gh CLI (GH_HOST for GHES).
 * @param pr parsed PR link
 * @returns PR info or null on any failure
 */
export async function fetchGhPrInfo(pr: PrLink): Promise<PrInfo | null> {
    const host = pr.host.replace(/^https?:\/\//, '');
    const env = host === 'github.com'
        ? process.env
        : { ...process.env, GH_HOST: host };
    const args = [
        'pr', 'view', pr.number,
        '--repo', `${pr.owner}/${pr.repo}`,
        '--json', 'title,headRefName',
    ];
    try {
        const { stdout } = await execFileAsync('gh', args, { env });
        const parsed = JSON.parse(stdout);
        return {
            title: parsed.title ?? null,
            branch: parsed.headRefName ?? null,
        };
    } catch {
        return null;
    }
}
