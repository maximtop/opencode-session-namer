import type { PrLink } from './types';

const GH_HOST = 'https://github.com';

/**
 * Blocked repo-segment shapes in the short owner/repo#N form: a file-typed
 * path like src/rename.ts#42 must not parse into owner="src", repo="rename.ts"
 * (a GitHub repo reference with a file extension is never intended).
 */
const FILE_EXT_RE = new RegExp(
    `\\.(${[
        'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'txt',
        'py', 'rb', 'go', 'rs', 'java', 'kt', 'cpp', 'c', 'h', 'css',
        'html', 'yaml', 'yml', 'xml', 'sh', 'bat', 'ps1',
    ].join('|')})$`,
    'i',
);

/**
 * Parses one candidate token into a PR link. Tolerates anything after the PR
 * number (trailing path like `/changes`, `/files`, a query or a `#fragment`),
 * markdown emphasis around the link (`**…**`, `_…_`), and accepts both full
 * URLs (`https://host/owner/repo/pull/N…`) and the short `owner/repo#N` form
 * (github.com).
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
        if (owner && repo && number
            && !FILE_EXT_RE.test(owner)
            && !FILE_EXT_RE.test(repo)) {
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
        if (link && link.owner && link.repo) {
            return link;
        }
    }
    return null;
}
