import { promises as fsp } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { humanize } from './text';
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
 * Resolves the project label from the session directory.
 *
 * - Regular checkout: the directory basename.
 * - Linked worktree: `.git` is a file pointing into the main repo, so the
 * label is the main repo name and the key comes from the branch.
 * - Scratch dirs (chats, tmp, non-git) → null, session keeps the auto-title.
 * @param dir session directory
 * @param extractAgKey issue key extractor
 * @returns project info or null for scratch dirs
 */
export async function projectForDirectory(
    dir: string | undefined,
    extractAgKey: AgKeyExtractor,
): Promise<ProjectInfo | null> {
    if (!dir) {
        return null;
    }
    const isScratch = dir.includes('/.config/openchamber/chats/')
        || dir.startsWith(tmpdir())
        || dir.startsWith('/tmp/')
        || dir.startsWith('/var/folders/');
    if (isScratch) {
        return null;
    }
    const gitPath = join(dir, '.git');
    let stat;
    try {
        stat = await fsp.lstat(gitPath);
    } catch {
        return null;
    }
    if (stat.isDirectory()) {
        return { label: humanize(basename(dir)), agKey: null };
    }
    if (!stat.isFile()) {
        return null;
    }
    const fallback: ProjectInfo = {
        label: humanize(basename(dir)),
        agKey: null,
    };
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
        return { label: humanize(basename(worktree[1])), agKey };
    } catch {
        return fallback;
    }
}
