import type { PrLink } from './types';

const URL_SCAN_CHARS = 2000;

/**
 * Finds the target PR link in the first user message. Review prompt
 * templates tend to carry example links further down, so only the head of
 * the message is scanned and deep links (#fragments, ?queries) are skipped.
 * @param text first user message text
 * @returns parsed PR link or null
 */
export function findPrUrl(text: string): PrLink | null {
    const head = text.slice(0, URL_SCAN_CHARS);
    const urls = head.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? [];
    for (const raw of urls) {
        const url = raw.replace(/[.,;:!?]+$/, '');
        if (url.includes('#') || url.includes('?')) {
            continue;
        }
        const match = url.match(
            /^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/,
        );
        if (match) {
            const [, host, owner, repo, number] = match;
            if (host && owner && repo && number) {
                return { host, owner, repo, number };
            }
        }
    }
    return null;
}
