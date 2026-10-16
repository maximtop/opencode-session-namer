import { promises as fsp } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import type { AgKeyExtractor, ProjectInfo } from './types';

/**
 * Reads the issue key from the branch recorded in a worktree HEAD file.
 * @param gitdir worktree gitdir path
 * @param extractAgKey issue key extractor
 * @returns issue key or null
 */
async function branchAgKey(
    gitdir: string,
    extractAgKey: AgKeyExtractor,
): Promise<string | null> {
    try {
        const head = await fsp.readFile(join(gitdir, 'HEAD'), 'utf8');
        const match = head.match(/ref:\s*refs\/heads\/(.+)/);
        return match?.[1] ? extractAgKey(match[1].trim()) : null;
    } catch {
        return null;
    }
}

/**
 * Normalizes a path for comparison: forward slashes, no trailing slash.
 * The POSIX root stays `/`, so the ancestor walk ends there instead of
 * stepping to an empty, cwd-relative path.
 * @param path path to normalize
 * @returns normalized path
 */
function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
}

/**
 * Home directory paths: as configured and with symlinks resolved, so the
 * ancestor walk stops at home whichever form the session directory arrives
 * in.
 * @returns absolute home directory paths
 */
async function homePaths(): Promise<Set<string>> {
    const paths = new Set<string>();
    const configured = normalizePath(homedir());
    if (configured) {
        paths.add(configured);
        try {
            paths.add(normalizePath(await fsp.realpath(configured)));
        } catch {
            // home is not readable: the configured path is enough
        }
    }
    return paths;
}

/**
 * Root directories whose sessions are scratch: the system temp directory
 * and the well-known temp locations, each as written and with symlinks
 * resolved. macOS reports temp paths both ways (`/tmp` and `/private/tmp`,
 * `/var/folders/...` and `/private/var/folders/...`) and opencode passes
 * the resolved cwd.
 * @returns absolute scratch roots without a trailing slash
 */
async function resolveScratchRoots(): Promise<string[]> {
    const candidates = new Set([
        tmpdir(),
        '/tmp',
        '/var/tmp',
        '/var/folders',
        '/private/tmp',
        '/private/var/tmp',
        '/private/var/folders',
    ]);
    for (const candidate of [...candidates]) {
        try {
            candidates.add(await fsp.realpath(candidate));
        } catch {
            // the location does not exist on this system
        }
    }
    return [...candidates].map((candidate) => normalizePath(candidate));
}

let scratchRootsCache: Promise<string[]> | undefined;

/**
 * Scratch roots, resolved once per process: the temp locations do not
 * change while the plugin runs.
 * @returns absolute scratch roots without a trailing slash
 */
function scratchRoots(): Promise<string[]> {
    scratchRootsCache ??= resolveScratchRoots();
    return scratchRootsCache;
}

/**
 * Checks whether the session directory is a scratch location.
 * @param dir normalized session directory
 * @returns true when the session must keep the plain auto-title
 */
async function isScratch(dir: string): Promise<boolean> {
    if (dir.includes('/.config/openchamber/chats/')) {
        return true;
    }
    const roots = await scratchRoots();
    return roots.some((root) => dir === root || dir.startsWith(`${root}/`));
}

/**
 * Kind of a `.git` entry: a directory for a regular checkout, a file for a
 * linked worktree or a submodule.
 */
type GitEntryKind = 'directory' | 'file';

/**
 * Project info for a directory that carries a `.git` entry.
 * @param root directory that contains the `.git` entry
 * @param kind `.git` entry kind
 * @param extractAgKey issue key extractor
 * @returns project info
 */
async function gitProject(
    root: string,
    kind: GitEntryKind,
    extractAgKey: AgKeyExtractor,
): Promise<ProjectInfo> {
    const name = basename(root);
    const gitPath = join(root, '.git');
    if (kind === 'directory') {
        // regular checkout: the branch (and its issue key) lives in
        // .git/HEAD
        const agKey = await branchAgKey(gitPath, extractAgKey);
        return { name, agKey };
    }
    const fallback: ProjectInfo = { name, agKey: null };
    try {
        const content = await fsp.readFile(gitPath, 'utf8');
        const gitdirLine = content.match(/gitdir:\s*(.+)/);
        if (!gitdirLine?.[1]) {
            return fallback;
        }
        const gitdir = gitdirLine[1].trim();
        const worktree = gitdir.match(
            /^(.*?)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/,
        );
        if (!worktree?.[1]) {
            return fallback; // submodule or other layout
        }
        const agKey = await branchAgKey(gitdir, extractAgKey);
        return { name: basename(worktree[1]), agKey };
    } catch {
        return fallback;
    }
}

/**
 * Resolves the project name from the session directory.
 *
 * - Git checkout: the nearest ancestor with a `.git` entry. A session in
 * `repo/src` is labeled by the repo name; the key comes from the branch
 * recorded in `.git/HEAD`, when it has one.
 * - Linked worktree: `.git` is a file pointing into the main repo, so the
 * name is the main repo name and the key comes from the branch.
 * - Plain directory (no `.git` up to the home directory, or up to the
 * filesystem root outside home): the directory basename with no key, so a
 * non-git project still gets a prefix.
 * - Scratch dirs (chats, tmp), the home directory, the filesystem root and
 * unreadable paths → null, the session keeps the auto-title.
 * @param dir session directory
 * @param extractAgKey issue key extractor
 * @returns project info or null when the session keeps the auto-title
 */
export async function projectForDirectory(
    dir: string | undefined,
    extractAgKey: AgKeyExtractor,
): Promise<ProjectInfo | null> {
    if (!dir) {
        return null;
    }
    const resolved = normalizePath(resolve(dir));
    if (await isScratch(resolved)) {
        return null;
    }
    const name = basename(resolved);
    if (!name) {
        // the filesystem root has no name to label a session with
        return null;
    }
    try {
        const stat = await fsp.stat(resolved);
        if (!stat.isDirectory()) {
            return null;
        }
    } catch {
        // a deleted or unreadable session directory: keep the auto-title
        return null;
    }
    const homes = await homePaths();
    if (homes.has(resolved)) {
        // the home directory is not a project
        return null;
    }
    let current = resolved;
    for (;;) {
        if (homes.has(current) || current === dirname(current)) {
            // no `.git` up to the boundary: a plain project gets its name
            return { name, agKey: null };
        }
        try {
            const stat = await fsp.stat(join(current, '.git'));
            if (!stat.isDirectory() && !stat.isFile()) {
                // an unexpected `.git` entry type: do not guess a project
                return null;
            }
            const kind = stat.isDirectory() ? 'directory' : 'file';
            return await gitProject(current, kind, extractAgKey);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                // an unreadable directory: label nothing instead of guessing
                return null;
            }
        }
        current = normalizePath(dirname(current));
    }
}
