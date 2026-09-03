import type { PrLink } from './types';

const GH_HOST = 'https://github.com';

/**
 * Parses one candidate token into a PR link. Tolerates anything after the PR
 * number (trailing path like `/changes`, `/files`, a query or a `#fragment`),
 * markdown emphasis around the link (`**…**`, `_…_`), and accepts both full
 * URLs (`https://host/owner/repo/pull/N…`) and the short `owner/repo#N` form
 * (github.com). Short-form matches are flagged so the caller can verify them
 * with gh — `src/rename.ts#42` is a file reference, not a PR.
 * @param raw candidate token
 * @returns parsed PR link or null
 */
function parsePrUrlShape(raw: string): PrLink | null {
    const cleaned = raw.trim()
        .replace(/^[*_]+/, '')
        .replace(/[*_.,;:!?)\]]+$/, '');
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
            return { host: GH_HOST, owner, repo, number, shortForm: true };
        }
    }
    return null;
}

/**
 * Finds every PR-shaped candidate in the message, best first: full URLs
 * (they carry the host and may sit inside a markdown `[label](url)`), then
 * short `owner/repo#N` forms; duplicates (a bare URL matched by both
 * passes) are removed. Callers walk the list in order so an unverifiable
 * short form — a file reference like `src/rename.ts#42` — never shadows a
 * real PR link later in the message.
 * @param text first user message text
 * @returns parsed PR links in preference order
 */
export function findPrCandidates(text: string): PrLink[] {
    const out: PrLink[] = [];
    const seen = new Set<string>();
    const push = (link: PrLink | null): void => {
        if (!link) {
            return;
        }
        const key = `${link.host}/${link.owner}/${link.repo}#${link.number}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(link);
        }
    };
    for (const raw of text.match(/https?:\/\/[^\s"'`)\]]+/g) ?? []) {
        push(parsePrUrlShape(raw));
    }
    for (const token of text.split(/[\s"'`()[\]<>]+/)) {
        push(parsePrUrlShape(token));
    }
    return out;
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
    return findPrCandidates(text)[0] ?? null;
}
