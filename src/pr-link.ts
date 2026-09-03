import type { PrLink } from './types';

const GH_HOST = 'https://github.com';

/**
 * Parses one candidate token into a PR link. Tolerates anything after the PR
 * number (trailing path like `/changes`, `/files`, a query or a `#fragment`),
 * and accepts both full URLs (`https://host/owner/repo/pull/N…`) and the
 * short `owner/repo#N` form (github.com).
 * @param raw candidate token
 * @returns parsed PR link or null
 */
export function parsePrUrlShape(raw: string): PrLink | null {
    const cleaned = raw.trim().replace(/[.,;:!?)\]]+$/, '');
    const full = cleaned.match(
        /^(https?:\/\/[^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/,
    );
    if (full) {
        const [, host, owner, repo, number] = full;
        if (host && owner && repo && number) {
            return { host, owner, repo, number };
        }
    }
    const short = cleaned.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
    if (short) {
        const [, owner, repo, number] = short;
        if (owner && repo && number) {
            return { host: GH_HOST, owner, repo, number };
        }
    }
    return null;
}

/**
 * Finds the target PR link in the first user message. The whole message is
 * scanned: expanded command prompts can carry the link deep into the body,
 * so no head window is applied. Full URLs are matched first (they carry the
 * host and may sit inside a markdown `[label](url)`), then tokens are tried
 * for the short `owner/repo#N` form; the first parseable link wins.
 * @param text first user message text
 * @returns parsed PR link or null
 */
export function findPrUrl(text: string): PrLink | null {
    const urls = text.match(/https?:\/\/[^\s"'`)\]]+/g) ?? [];
    for (const raw of urls) {
        const link = parsePrUrlShape(raw);
        if (link) {
            return link;
        }
    }
    for (const token of text.split(/[\s"'`()[\]<>]+/)) {
        const link = parsePrUrlShape(token);
        if (link) {
            return link;
        }
    }
    return null;
}
