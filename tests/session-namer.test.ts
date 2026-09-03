/**
 * Mock-client test suite. Run: pnpm test
 * PR cases make real `gh` calls (needs `gh auth login`).
 */
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import type { Plugin } from '@opencode-ai/plugin';

const tmp = await fsp.mkdtemp(join(tmpdir(), 'session-namer-test-'));
process.env.SESSION_NAMER_DELAY_MS = '30';
process.env.SESSION_NAMER_CONFIG = join(tmp, 'config.json');
process.env.SESSION_NAMER_STATE = join(tmp, 'state.json');

type Hooks = NonNullable<Awaited<ReturnType<Plugin>>>;
type Ctx = Parameters<Plugin>[0];
type PluginClient = Ctx['client'];

let SessionNamer: Plugin;

// Portable fixtures: a plain git project and a linked-worktree pair.
// They live next to this file (not in tmp) because the plugin deliberately
// ignores sessions whose directory is inside a temp/scratch location.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(repoRoot, '.test-fixtures');
const gitProject = join(fixtures, 'browser-extension');
const mainRepo = join(fixtures, 'main-repo');
const wtGitdir = join(mainRepo, '.git', 'worktrees', 'fix-AG-56856');
const worktree = join(fixtures, 'wt', 'fix-AG-56856');

beforeAll(async () => {
    await fsp.mkdir(join(gitProject, '.git'), { recursive: true });
    await fsp.mkdir(wtGitdir, { recursive: true });
    await fsp.writeFile(join(wtGitdir, 'HEAD'), 'ref: refs/heads/fix/AG-56856\n');
    await fsp.mkdir(worktree, { recursive: true });
    await fsp.writeFile(join(worktree, '.git'), `gitdir: ${wtGitdir}\n`);
    const plugin = await import('../src/index');
    SessionNamer = plugin.SessionNamer;
});

interface FakeSession {
    id: string;
    title: string;
    directory: string;
    parentID?: string;
}

function freshSession(over: Partial<FakeSession> = {}): FakeSession {
    return {
        id: `ses_${Math.random().toString(36).slice(2, 10)}`,
        title: 'New session - 2026-09-03T10:00:00.000Z',
        directory: gitProject,
        ...over,
    };
}

interface MockOptions {
    session: FakeSession;
    firstUserText: string;
    shortenReply?: string;
    failCreate?: boolean;
}

function makeClient(options: MockOptions) {
    const { session, firstUserText, shortenReply, failCreate } = options;
    const updates: Array<{ body: { title?: string } }> = [];
    const childCalls = {
        created: 0, prompted: 0, deleted: 0, lastPrompt: null as string | null,
    };
    const client = {
        app: { log: async () => ({}) },
        config: {
            get: async () => ({
                data: { small_model: 'tokenguard/deepseek-v4-flash' },
            }),
        },
        session: {
            get: async () => ({ data: session }),
            messages: async ({ path }: { path: { id: string } }) => {
                if (path.id.startsWith('child_')) {
                    return {
                        data: [{
                            info: { role: 'assistant', time: { created: 2 } },
                            parts: [{ type: 'text', text: shortenReply ?? 'shortened' }],
                        }],
                    };
                }
                return {
                    data: [{
                        info: { role: 'user', time: { created: 1 } },
                        parts: [{ type: 'text', text: firstUserText }],
                    }],
                };
            },
            update: async (opts: { body: { title?: string } }) => {
                updates.push(opts);
                if (opts.body.title) {
                    session.title = opts.body.title;
                }
                return { data: session };
            },
            create: async () => {
                if (failCreate) {
                    throw new Error('boom');
                }
                childCalls.created += 1;
                return { data: { id: `child_${session.id}` } };
            },
            prompt: async (
                opts: { body: { parts: Array<{ text: string }> } },
            ) => {
                childCalls.prompted += 1;
                childCalls.lastPrompt = opts.body.parts[0]?.text ?? null;
                return { data: {} };
            },
            delete: async () => {
                childCalls.deleted += 1;
                return { data: true };
            },
        },
    };
    return { client: client as unknown as PluginClient, updates, childCalls };
}

interface DriveOptions {
    autoTitle?: string;
    foreignTitle?: string;
    updates: Array<{ body: { title?: string } }>;
    expectUpdate?: boolean;
}

async function waitFor(
    cond: () => boolean,
    timeoutMs = 20000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) {
            return true;
        }
        await new Promise((r) => {
            setTimeout(r, 100);
        });
    }
    return cond();
}

async function drive(
    hooks: Hooks,
    session: FakeSession,
    options: DriveOptions,
): Promise<void> {
    const {
        autoTitle, foreignTitle, updates, expectUpdate = true,
    } = options;
    const emit = async (event: unknown) => {
        await hooks.event?.({ event: event as never });
    };
    await emit({ type: 'session.created', properties: { info: { ...session } } });
    await emit({
        type: 'message.updated',
        properties: { info: { role: 'user', sessionID: session.id } },
    });
    if (autoTitle) {
        session.title = autoTitle;
        await emit({
            type: 'session.updated',
            properties: { info: { ...session } },
        });
    }
    if (foreignTitle) {
        session.title = foreignTitle;
        await emit({
            type: 'session.updated',
            properties: { info: { ...session } },
        });
    }
    await emit({ type: 'session.idle', properties: { sessionID: session.id } });
    if (expectUpdate) {
        await waitFor(() => updates.length > 0);
    } else {
        await new Promise((r) => {
            setTimeout(r, 800);
        });
    }
    await new Promise((r) => {
        setTimeout(r, 300);
    });
}

async function writeConfig(cfg: Record<string, unknown>): Promise<void> {
    await fsp.writeFile(
        process.env.SESSION_NAMER_CONFIG as string,
        JSON.stringify(cfg),
    );
}

const PR_URL = 'https://github.com/AdguardTeam/FiltersRegistry/pull/1226';

describe('session-namer', () => {
    it('names PR sessions [repo] Review pull/N + PR title', async () => {
        await writeConfig({});
        const session = freshSession();
        const { client, updates } = makeClient({
            session,
            firstUserText: `review this ${PR_URL} please`,
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Review pull request', updates });
        expect(updates).toHaveLength(1);
        const title = updates[0]?.body.title ?? '';
        expect(title.startsWith('[filters registry] Review pull/1226 ')).toBe(true);
        expect(title.length).toBeGreaterThan(40);
        expect(title.length).toBeLessThanOrEqual(90);
    }, 30000);

    it('ignores example links in review templates', async () => {
        await writeConfig({});
        const session = freshSession();
        const template = [
            `Review the changeset. Auto-detect from \`${PR_URL}\`.`,
            '',
            ...Array(40).fill('... filler instructions ...'),
            '### Examples',
            '- `https://github.com/AdGuardSoftwareLimited/ext-popup-blocker/pull/10/changes#diff-abcR137`',
            '- `https://github.com/AdguardTeam/compilersite/pull/55/files`',
        ].join('\n');
        const { client, updates } = makeClient({
            session,
            firstUserText: template,
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Review changeset', updates });
        expect(updates).toHaveLength(1);
        expect(updates[0]?.body.title).toContain('pull/1226');
    }, 30000);

    it('prefixes non-PR sessions with [project]', async () => {
        await writeConfig({});
        const session = freshSession({ directory: gitProject });
        const { client, updates } = makeClient({ session, firstUserText: 'fix it' });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Fixing the flaky test', updates });
        expect(updates).toHaveLength(1);
        expect(updates[0]?.body.title).toBe('[browser-extension] Fixing the flaky test');
    });

    it('detects worktrees via the .git file (main repo + branch key)', async () => {
        await writeConfig({});
        const session = freshSession({ directory: worktree });
        const { client, updates } = makeClient({ session, firstUserText: 'continue' });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Continue stealth fix', updates });
        expect(updates).toHaveLength(1);
        expect(updates[0]?.body.title).toBe('[main-repo] AG-56856 Continue stealth fix');
    });

    it('never overrides a manual rename', async () => {
        await writeConfig({});
        const session = freshSession();
        const { client, updates } = makeClient({
            session,
            firstUserText: PR_URL,
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, {
            autoTitle: 'Review pull request',
            foreignTitle: 'my custom name',
            updates,
            expectUpdate: false,
        });
        expect(updates).toHaveLength(0);
        expect(session.title).toBe('my custom name');
    });

    it('derives a name from the message when the auto-title failed', async () => {
        await writeConfig({});
        const session = freshSession({ directory: gitProject });
        const { client, updates } = makeClient({
            session,
            firstUserText: 'fix the broken tsurlfilter test\nmore details here',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { updates });
        expect(updates).toHaveLength(1);
        expect(updates[0]?.body.title).toBe(
            '[browser-extension] fix the broken tsurlfilter test',
        );
    });

    it('leaves scratch chat dirs alone', async () => {
        await writeConfig({});
        const session = freshSession({
            directory: '/home/tester/.config/openchamber/chats/2026-09-03/session-xyz',
        });
        const { client, updates } = makeClient({ session, firstUserText: 'hi there' });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, {
            autoTitle: 'Joke request',
            updates,
            expectUpdate: false,
        });
        expect(updates).toHaveLength(0);
    });

    it('renames exactly once even across later idles', async () => {
        await writeConfig({});
        const session = freshSession({ directory: gitProject });
        const { client, updates } = makeClient({ session, firstUserText: 'do a thing' });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Feature work', updates });
        expect(updates).toHaveLength(1);
        session.title = 'renamed by user later';
        await hooks.event?.({
            event: { type: 'session.idle', properties: { sessionID: session.id } } as never,
        });
        await new Promise((r) => {
            setTimeout(r, 200);
        });
        expect(updates).toHaveLength(1);
        expect(session.title).toBe('renamed by user later');
    });

    it('skips sub-agent sessions', async () => {
        await writeConfig({});
        const session = freshSession({ parentID: 'ses_parent' });
        const { client, updates } = makeClient({ session, firstUserText: 'subtask' });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, {
            autoTitle: 'Subtask (@explore subagent)',
            updates,
            expectUpdate: false,
        });
        expect(updates).toHaveLength(0);
    });

    it('honors a custom template and prPrefix', async () => {
        await writeConfig({
            template: '{project} | {agKey} | {title}',
            prPrefix: 'PR#{number}: ',
        });
        const session = freshSession();
        const { client, updates } = makeClient({
            session,
            firstUserText: `review ${PR_URL}`,
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Review pull request', updates });
        expect(updates).toHaveLength(1);
        expect(updates[0]?.body.title?.startsWith('filters registry | PR#1226: ')).toBe(true);
    }, 30000);

    it('smartShorten shortens overlong titles via a child session', async () => {
        await writeConfig({ smartShorten: true });
        const session = freshSession();
        const { client, updates, childCalls } = makeClient({
            session,
            firstUserText: `review ${PR_URL}`,
            shortenReply: 'Strip version/timeUpdated fields',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Review pull request', updates });
        expect(updates).toHaveLength(1);
        expect(updates[0]?.body.title).toBe(
            '[filters registry] Review pull/1226 Strip version/timeUpdated fields',
        );
        expect(childCalls.created).toBe(1);
        expect(childCalls.prompted).toBe(1);
        expect(childCalls.deleted).toBe(1);
    }, 30000);

    it('falls back to truncation when smartShorten fails', async () => {
        await writeConfig({ smartShorten: true });
        const session = freshSession();
        const { client, updates } = makeClient({
            session,
            firstUserText: `review ${PR_URL}`,
            failCreate: true,
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Review pull request', updates });
        expect(updates).toHaveLength(1);
        const title = updates[0]?.body.title ?? '';
        expect(title.length).toBeLessThanOrEqual(90);
        expect(title.startsWith('[filters registry] Review pull/1226 Strips')).toBe(true);
    }, 30000);
});
