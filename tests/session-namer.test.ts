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
import type {
    PluginClient,
    TrackedSession,
} from '../src/types';
import { findPrUrl } from '../src/pr-link';
import { loadConfig } from '../src/config';
import { SessionNamer } from '../src/index';
import type { ChangePatch } from '../src/tracking';

const tmp = await fsp.mkdtemp(join(tmpdir(), 'session-namer-test-'));
process.env.SESSION_NAMER_DELAY_MS = '30';
process.env.SESSION_NAMER_CONFIG = join(tmp, 'config.json');
process.env.SESSION_NAMER_STATE = join(tmp, 'state.json');

/**
 * The hooks object returned by the plugin factory.
 */
type Hooks = NonNullable<Awaited<ReturnType<Plugin>>>;
/**
 * The plugin context type (used to type the mocked context).
 */
type Ctx = Parameters<Plugin>[0];

// Portable fixtures: plain git projects (one on a keyed branch, one
// branchless) and a linked-worktree pair. They live next to this file (not
// in tmp) because the plugin deliberately ignores sessions whose directory
// is inside a temp/scratch location.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(repoRoot, '.test-fixtures');
const gitProject = join(fixtures, 'browser-extension');
const keyedProject = join(fixtures, 'keyed-project');
const mainRepo = join(fixtures, 'main-repo');
const wtGitdir = join(mainRepo, '.git', 'worktrees', 'fix-AG-56856');
const worktree = join(fixtures, 'wt', 'fix-AG-56856');

beforeAll(async () => {
    await fsp.mkdir(join(gitProject, '.git'), { recursive: true });
    await fsp.mkdir(join(keyedProject, '.git'), { recursive: true });
    await fsp.writeFile(
        join(keyedProject, '.git', 'HEAD'),
        'ref: refs/heads/feature/AG-12345\n',
    );
    await fsp.mkdir(wtGitdir, { recursive: true });
    await fsp.writeFile(join(wtGitdir, 'HEAD'), 'ref: refs/heads/fix/AG-56856\n');
    await fsp.mkdir(worktree, { recursive: true });
    await fsp.writeFile(join(worktree, '.git'), `gitdir: ${wtGitdir}\n`);
});

/**
 * Minimal session object for the mock client.
 */
interface FakeSession {
    /**
     * Session id.
     */
    id: string;
    /**
     * Current session title; mutated by the mocked session.update.
     */
    title: string;
    /**
     * Session working directory.
     */
    directory: string;
    /**
     * Parent id for sub-agent sessions.
     */
    parentID?: string;
}

/**
 * Builds a fresh fake session with a default ("New session") title.
 * @param over field overrides
 * @returns fake session
 */
function freshSession(over: Partial<FakeSession> = {}): FakeSession {
    return {
        id: `ses_${Math.random().toString(36).slice(2, 10)}`,
        title: 'New session - 2026-09-03T10:00:00.000Z',
        directory: gitProject,
        ...over,
    };
}

/**
 * Inputs for the mock client.
 */
interface MockOptions {
    /**
     * Session the mock serves.
     */
    session: FakeSession;
    /**
     * Text of the first user message.
     */
    firstUserText: string;
    /**
     * Canned assistant reply for the smartShorten child session.
     */
    shortenReply?: string;
    /**
     * Make session.create throw to simulate smartShorten failure.
     */
    failCreate?: boolean;
    /**
     * Fail this many first session.update calls with an SDK-style error
     * (simulates a transient server error on the title write).
     */
    failUpdates?: number;
    /**
     * When set, session.messages returns no user text until the predicate
     * yields true (simulates an idle before the first message).
     */
    suppressUserTextUntil?: () => boolean;
    /**
     * Chronological user messages (null entry = a message without a text
     * part). Defaults to a single message with firstUserText.
     */
    userTexts?: Array<string | null>;
}

/**
 * Builds a mock opencode SDK client and its spies.
 * @param options mock inputs
 * @returns mock client, captured title updates, child-session call counters
 */
function makeClient(options: MockOptions) {
    const {
        session, firstUserText, shortenReply, failCreate, suppressUserTextUntil,
        userTexts, failUpdates,
    } = options;
    const updates: Array<{ body: { title?: string } }> = [];
    let failedUpdates = failUpdates ?? 0;
    const childCalls = {
        created: 0, prompted: 0, deleted: 0, lastPrompt: null as string | null,
    };
    // Captured query of every session call, for directory assertions.
    const queries: Array<{ method: string; directory?: string }> = [];
    const recordQuery = (method: string, opts: {
        query?: { directory?: string };
    }): void => {
        queries.push({ method, directory: opts.query?.directory });
    };
    const client = {
        app: { log: async () => ({}) },
        config: {
            get: async () => ({
                data: { small_model: 'tokenguard/deepseek-v4-flash' },
            }),
        },
        session: {
            get: async (opts: { query?: { directory?: string } }) => {
                recordQuery('get', opts);
                return { data: session };
            },
            messages: async (
                opts: { path: { id: string }; query?: { directory?: string } },
            ) => {
                recordQuery('messages', opts);
                if (opts.path.id.startsWith('child_')) {
                    return {
                        data: [{
                            info: { role: 'assistant', time: { created: 2 } },
                            parts: [{ type: 'text', text: shortenReply ?? 'shortened' }],
                        }],
                    };
                }
                if (suppressUserTextUntil && !suppressUserTextUntil()) {
                    return { data: [] };
                }
                const texts = userTexts ?? [firstUserText];
                return {
                    data: texts.map((text, i) => ({
                        info: { role: 'user', time: { created: i + 1 } },
                        parts: text === null
                            ? [{ type: 'file', filePath: 'attachment.bin' }]
                            : [{ type: 'text', text }],
                    })),
                };
            },
            update: async (opts: {
                body: { title?: string };
                query?: { directory?: string };
            }) => {
                recordQuery('update', opts);
                if (failedUpdates > 0) {
                    failedUpdates -= 1;
                    return { error: { message: 'boom' } };
                }
                updates.push(opts);
                if (opts.body.title) {
                    session.title = opts.body.title;
                }
                return { data: session };
            },
            create: async (opts: { query?: { directory?: string } }) => {
                recordQuery('create', opts);
                if (failCreate) {
                    throw new Error('boom');
                }
                childCalls.created += 1;
                return { data: { id: `child_${session.id}` } };
            },
            prompt: async (
                opts: {
                    body: { parts: Array<{ text: string }> };
                    query?: { directory?: string };
                },
            ) => {
                recordQuery('prompt', opts);
                childCalls.prompted += 1;
                childCalls.lastPrompt = opts.body.parts[0]?.text ?? null;
                return { data: {} };
            },
            delete: async (opts: { query?: { directory?: string } }) => {
                recordQuery('delete', opts);
                childCalls.deleted += 1;
                return { data: true };
            },
        },
    };
    return {
        client: client as unknown as PluginClient,
        updates,
        childCalls,
        queries,
    };
}

/**
 * Options for the scenario driver.
 */
interface DriveOptions {
    /**
     * Simulate the built-in auto-title landing after the first message.
     */
    autoTitle?: string;
    /**
     * Simulate a manual rename after the auto-title.
     */
    foreignTitle?: string;
    /**
     * Captured session.update calls from the mock client.
     */
    updates: Array<{ body: { title?: string } }>;
    /**
     * Wait for a rename (true) or settle a fixed time (false).
     */
    expectUpdate?: boolean;
}

/**
 * Sleeps for the given number of milliseconds.
 * @param ms duration
 */
async function sleep(ms: number): Promise<void> {
    await new Promise((r) => {
        setTimeout(r, ms);
    });
}

/**
 * Polls a condition until it holds or the timeout elapses.
 * @param cond condition to poll
 * @param timeoutMs polling timeout
 * @returns whether the condition held before the timeout
 */
async function waitFor(
    cond: () => boolean,
    timeoutMs = 20000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) {
            return true;
        }
        await sleep(100);
    }
    return cond();
}

/**
 * Feeds one event envelope through the plugin hook.
 * @param hooks plugin hooks under test
 * @param event event payload
 */
async function emit(hooks: Hooks, event: unknown): Promise<void> {
    await hooks.event?.({ event: event as never });
}

/**
 * Drives a full first-turn scenario through the plugin event hook: session
 * created, first user message, optional auto-title, optional manual rename,
 * then idle — and waits for the rename to settle.
 * @param hooks plugin hooks under test
 * @param session fake session
 * @param options scenario options
 */
async function drive(
    hooks: Hooks,
    session: FakeSession,
    options: DriveOptions,
): Promise<void> {
    const {
        autoTitle, foreignTitle, updates, expectUpdate = true,
    } = options;
    await emit(hooks, {
        type: 'session.created',
        properties: { info: { ...session } },
    });
    await emit(hooks, {
        type: 'message.updated',
        properties: { info: { role: 'user', sessionID: session.id } },
    });
    if (autoTitle) {
        session.title = autoTitle;
        await emit(hooks, {
            type: 'session.updated',
            properties: { info: { ...session } },
        });
    }
    if (foreignTitle) {
        session.title = foreignTitle;
        await emit(hooks, {
            type: 'session.updated',
            properties: { info: { ...session } },
        });
    }
    await emit(hooks, {
        type: 'session.idle',
        properties: { sessionID: session.id },
    });
    if (expectUpdate) {
        await waitFor(() => updates.length > 0);
    } else {
        await sleep(800);
    }
    await sleep(300);
}

/**
 * Writes the plugin config file the next factory call will read.
 * @param cfg config overrides (empty object means defaults)
 */
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
        const { client, updates } = makeClient({
            session,
            firstUserText: 'fix it',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Fixing the flaky test', updates });
        expect(updates).toHaveLength(1);
        expect(updates[0]?.body.title).toBe('[browser-extension] Fixing the flaky test');
    });

    it('detects worktrees via the .git file (main repo + branch key)', async () => {
        await writeConfig({});
        const session = freshSession({ directory: worktree });
        const { client, updates } = makeClient({
            session,
            firstUserText: 'continue',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Continue stealth fix', updates });
        expect(updates).toHaveLength(1);
        expect(updates[0]?.body.title).toBe('[main-repo] AG-56856 Continue stealth fix');
    });

    it('picks the issue key from a regular checkout branch', async () => {
        await writeConfig({});
        const session = freshSession({ directory: keyedProject });
        const { client, updates } = makeClient({
            session,
            firstUserText: 'fix it',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Fixing the flaky test', updates });
        expect(updates).toHaveLength(1);
        expect(updates[0]?.body.title).toBe(
            '[keyed-project] AG-12345 Fixing the flaky test',
        );
    });

    it('retries the rename when the title write fails', async () => {
        await writeConfig({});
        const session = freshSession({ directory: gitProject });
        const { client, updates } = makeClient({
            session,
            firstUserText: 'fix the thing',
            failUpdates: 1,
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await emit(hooks, {
            type: 'session.created',
            properties: { info: { ...session } },
        });
        await emit(hooks, {
            type: 'message.updated',
            properties: { info: { role: 'user', sessionID: session.id } },
        });
        // the first attempt's write fails — nothing recorded, nothing burned
        await sleep(200);
        expect(updates).toHaveLength(0);
        // a later idle re-arms the rename and it succeeds
        await emit(hooks, {
            type: 'session.idle',
            properties: { sessionID: session.id },
        });
        await waitFor(() => updates.length > 0);
        expect(updates[0]?.body.title).toBe('[browser-extension] fix the thing');
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
        const { client, updates } = makeClient({
            session,
            firstUserText: 'hi there',
        });
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
        const { client, updates } = makeClient({
            session,
            firstUserText: 'do a thing',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Feature work', updates });
        expect(updates).toHaveLength(1);
        session.title = 'renamed by user later';
        await emit(hooks, {
            type: 'session.idle',
            properties: { sessionID: session.id },
        });
        await sleep(200);
        expect(updates).toHaveLength(1);
        expect(session.title).toBe('renamed by user later');
    });

    it('skips sub-agent sessions', async () => {
        await writeConfig({});
        const session = freshSession({ parentID: 'ses_parent' });
        const { client, updates } = makeClient({
            session,
            firstUserText: 'subtask',
        });
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

    it('can render a slash-separated template with an empty slot', async () => {
        await writeConfig({
            template: '{project}/{agKey}/{title}',
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
        expect(updates[0]?.body.title?.startsWith('filters registry/PR#1226: ')).toBe(true);
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

describe('classifyTitleChange (title provenance)', () => {
    const freshRec = (): TrackedSession => ({
        sawUserMessage: false,
        autoTitle: undefined,
        foreign: false,
        scheduled: false,
        lastTitle: undefined,
        renameAttempts: 0,
        child: false,
        givenUp: false,
        directory: undefined,
    });

    const applyTo = (rec: TrackedSession, patch: ChangePatch) => {
        rec.lastTitle = patch.lastTitle;
        rec.autoTitle = patch.autoTitle;
        rec.foreign = patch.foreign;
    };

    const classify = async (
        rec: TrackedSession,
        title: string,
    ) => {
        const { classifyTitleChange } = await import('../src/tracking');
        const patch = classifyTitleChange(rec, title);
        applyTo(rec, patch);
        return patch;
    };

    it('seeds the baseline on the first observed title', async () => {
        const rec = freshRec();
        rec.sawUserMessage = true;
        const patch = await classify(rec, 'New session - 2026-…');
        expect(patch.foreign).toBe(false);
        expect(patch.lastTitle).toBe('New session - 2026-…');
        expect(patch.autoTitle).toBeUndefined();
    });

    it('flags a title set before the first user message as foreign', async () => {
        const rec = freshRec();
        const first = await classify(rec, 'New session - 2026-…');
        expect(first.foreign).toBe(false);
        const second = await classify(rec, '#12 issue title from picker');
        expect(second.foreign).toBe(true);
    });

    it('tracks a default-title refresh before the message as non-foreign', async () => {
        const rec = freshRec();
        await classify(rec, 'New session - 2026-…');
        const patch = await classify(rec, 'New session - 2026-… (restored)');
        expect(patch.foreign).toBe(false);
    });

    it('captures the post-user-message change as the auto-title', async () => {
        const rec = freshRec();
        rec.sawUserMessage = true;
        await classify(rec, 'New session - 2026-…');
        const patch = await classify(rec, 'Review pull request');
        expect(patch.foreign).toBe(false);
        expect(patch.autoTitle).toBe('Review pull request');
    });

    it('flags a change away from the auto-title as manual', async () => {
        const rec = freshRec();
        rec.sawUserMessage = true;
        await classify(rec, 'New session - 2026-…');
        await classify(rec, 'Review pull request');
        const patch = await classify(rec, 'my custom name');
        expect(patch.foreign).toBe(true);
    });

    it('recovers after a reload mid-turn (baseline seeds, next change captures)', async () => {
        const rec = freshRec();
        rec.sawUserMessage = true;
        let patch = await classify(rec, 'Review pull request');
        expect(patch.autoTitle).toBeUndefined();
        patch = await classify(rec, 'Fixing the flaky test');
        expect(patch.autoTitle).toBe('Fixing the flaky test');
    });
});

describe('idle before the first user message', () => {
    it('does not burn the session and renames on a later idle', async () => {
        await writeConfig({});
        let sent = false;
        const session = freshSession({ directory: gitProject });
        const { client, updates } = makeClient({
            session,
            firstUserText: 'fix the broken test',
            suppressUserTextUntil: () => sent,
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await emit(hooks, {
            type: 'session.created',
            properties: { info: { ...session } },
        });
        await emit(hooks, {
            type: 'session.idle',
            properties: { sessionID: session.id },
        });
        await sleep(400);
        expect(updates).toHaveLength(0);
        expect(session.title).toBe('New session - 2026-09-03T10:00:00.000Z');
        sent = true;
        await emit(hooks, {
            type: 'message.updated',
            properties: { info: { role: 'user', sessionID: session.id } },
        });
        session.title = 'Fixing the flaky test';
        await emit(hooks, {
            type: 'session.updated',
            properties: { info: { ...session } },
        });
        await emit(hooks, {
            type: 'session.idle',
            properties: { sessionID: session.id },
        });
        await waitFor(() => updates.length > 0);
        expect(updates[0]?.body.title).toBe('[browser-extension] Fixing the flaky test');
    });

    it('re-arms a session given up after MAX attempts once a real message arrives', async () => {
        await writeConfig({});
        let sent = false;
        const session = freshSession({ directory: gitProject });
        const { client, updates } = makeClient({
            session,
            firstUserText: 'fix the broken test',
            suppressUserTextUntil: () => sent,
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await emit(hooks, {
            type: 'session.created',
            properties: { info: { ...session } },
        });
        // idle before the first message, repeatedly — exhausts the budget
        for (let i = 0; i < 12; i += 1) {
            await emit(hooks, {
                type: 'session.idle',
                properties: { sessionID: session.id },
            });
            await sleep(80);
        }
        expect(updates).toHaveLength(0);
        expect(session.title).toBe('New session - 2026-09-03T10:00:00.000Z');
        // the real first message arrives after the give-up: must re-arm
        sent = true;
        await emit(hooks, {
            type: 'message.updated',
            properties: { info: { role: 'user', sessionID: session.id } },
        });
        await waitFor(() => updates.length > 0);
        expect(updates[0]?.body.title).toBe('[browser-extension] fix the broken test');
    });
});

describe('first-message semantics', () => {
    it('names from the first user message when later messages are plain', async () => {
        await writeConfig({});
        const session = freshSession();
        const { client, updates } = makeClient({
            session,
            firstUserText: `review ${PR_URL}`,
            userTexts: [
                `review ${PR_URL}`,
                'and add more context here',
            ],
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { autoTitle: 'Review pull request', updates });
        expect(updates).toHaveLength(1);
        expect(updates[0]?.body.title).toContain('pull/1226');
    }, 30000);

    it('skips a textless first message and uses the first textful one', async () => {
        await writeConfig({});
        const session = freshSession();
        const { client, updates } = makeClient({
            session,
            firstUserText: `review ${PR_URL}`,
            userTexts: [null, `review ${PR_URL}`],
        });
        const hooks = await SessionNamer({ client } as Ctx);
        // the first user message has only a non-text part (no text)
        await emit(hooks, {
            type: 'session.created',
            properties: { info: { ...session } },
        });
        await emit(hooks, {
            type: 'message.updated',
            properties: { info: { role: 'user', sessionID: session.id } },
        });
        session.title = 'Review pull request';
        await emit(hooks, {
            type: 'session.updated',
            properties: { info: { ...session } },
        });
        await emit(hooks, {
            type: 'session.idle',
            properties: { sessionID: session.id },
        });
        await waitFor(() => updates.length > 0);
        expect(updates[0]?.body.title).toContain('pull/1226');
    }, 30000);
});

describe('fast message-triggered rename', () => {
    it('renames on the first user message without waiting for idle', async () => {
        await writeConfig({});
        const session = freshSession({ directory: gitProject });
        const { client, updates, queries } = makeClient({
            session,
            firstUserText: 'fix the thing',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await emit(hooks, {
            type: 'session.created',
            properties: { info: { ...session } },
        });
        await emit(hooks, {
            type: 'message.updated',
            properties: { info: { role: 'user', sessionID: session.id } },
        });
        // no idle event at all
        await waitFor(() => updates.length > 0);
        expect(updates[0]?.body.title).toBe('[browser-extension] fix the thing');
        // session.get must be scoped to the session's directory — the same
        // invariant the re-apply write fix enforced (every SDK call carries
        // query.directory on multi-directory servers)
        const get = queries.find((q) => q.method === 'get');
        expect(get?.directory).toBe(gitProject);
        const messages = queries.find((q) => q.method === 'messages');
        expect(messages?.directory).toBe(gitProject);
    });

    it('re-applies our title over a late duplicate of the recorded auto-title', async () => {
        await writeConfig({});
        const session = freshSession({ directory: gitProject });
        const { client, updates } = makeClient({
            session,
            firstUserText: 'fix the thing',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await emit(hooks, {
            type: 'session.created',
            properties: { info: { ...session } },
        });
        await emit(hooks, {
            type: 'message.updated',
            properties: { info: { role: 'user', sessionID: session.id } },
        });
        // the built-in auto-title lands before our rename fires
        session.title = 'Fixing the thing';
        await emit(hooks, {
            type: 'session.updated',
            properties: { info: { ...session } },
        });
        await waitFor(() => updates.length > 0);
        const ours = updates[0]?.body.title ?? '';
        expect(ours).toBe('[browser-extension] Fixing the thing');
        // a late duplicate write of that same auto-title is corrected once
        session.title = 'Fixing the thing';
        await emit(hooks, {
            type: 'session.updated',
            properties: { info: { ...session } },
        });
        await waitFor(() => updates.length > 1);
        expect(updates[1]?.body.title).toBe(ours);
        // a second correction is never applied (single correction window)
        session.title = 'Fixing the thing';
        await emit(hooks, {
            type: 'session.updated',
            properties: { info: { ...session } },
        });
        await sleep(300);
        expect(updates).toHaveLength(2);
        // after the first idle the window is closed entirely
        await emit(hooks, {
            type: 'session.idle',
            properties: { sessionID: session.id },
        });
        session.title = 'Fixing the thing';
        await emit(hooks, {
            type: 'session.updated',
            properties: { info: { ...session } },
        });
        await sleep(300);
        expect(updates).toHaveLength(2);
        expect(session.title).toBe('Fixing the thing');
    });

    it('never re-applies over a manual rename made before the first idle', async () => {
        await writeConfig({});
        const session = freshSession({ directory: gitProject });
        const { client, updates } = makeClient({
            session,
            firstUserText: 'fix the thing',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await emit(hooks, {
            type: 'session.created',
            properties: { info: { ...session } },
        });
        await emit(hooks, {
            type: 'message.updated',
            properties: { info: { role: 'user', sessionID: session.id } },
        });
        session.title = 'Fixing the thing';
        await emit(hooks, {
            type: 'session.updated',
            properties: { info: { ...session } },
        });
        await waitFor(() => updates.length > 0);
        expect(updates).toHaveLength(1);
        // a manual rename lands inside the correction window — it wins and
        // closes the window
        session.title = 'my manual name';
        await emit(hooks, {
            type: 'session.updated',
            properties: { info: { ...session } },
        });
        await sleep(300);
        expect(updates).toHaveLength(1);
        expect(session.title).toBe('my manual name');
        // a late auto-title write after the manual rename is left alone too
        session.title = 'Fixing the thing';
        await emit(hooks, {
            type: 'session.updated',
            properties: { info: { ...session } },
        });
        await sleep(300);
        expect(updates).toHaveLength(1);
        expect(session.title).toBe('Fixing the thing');
    });
});

describe('loadConfig (zod coercion)', () => {
    it('fills defaults for a missing/empty config', async () => {
        await writeConfig({});
        const cfg = await loadConfig();
        expect(cfg.template).toBe('[{project}] {agKey} {title}');
        expect(cfg.maxLength).toBe(90);
        expect(cfg.smartShorten).toBe(false);
        expect(cfg.smartShortenModel).toBeNull();
    });

    it('falls back per key on wrong types and coerces numeric strings', async () => {
        await writeConfig({
            template: 5,
            smartShorten: 'yes',
            smartShortenModel: 'tokenguard/deepseek-v4-flash',
            maxLength: '42',
            unknownKey: 'x',
        });
        const cfg = await loadConfig();
        expect(cfg.template).toBe('[{project}] {agKey} {title}');
        expect(cfg.smartShorten).toBe(false);
        expect(cfg.smartShortenModel).toBe('tokenguard/deepseek-v4-flash');
        expect(cfg.maxLength).toBe(42);
        expect(cfg).not.toHaveProperty('unknownKey');
    });

    it('rejects booleans, floats, zero and negatives for numeric fields', async () => {
        for (const bad of [true, 3.5, 0, -10, null]) {
            await writeConfig({ maxLength: bad });
            expect((await loadConfig()).maxLength).toBe(90);
        }
    });

    it('treats a broken config file as defaults', async () => {
        await fsp.writeFile(
            process.env.SESSION_NAMER_CONFIG as string,
            '{not json',
        );
        const cfg = await loadConfig();
        expect(cfg.template).toBe('[{project}] {agKey} {title}');
        expect(cfg.renameDelayMs).toBe(30);
    });

    it('coerces renameDelayMs from the file when no env override', async () => {
        const saved = process.env.SESSION_NAMER_DELAY_MS;
        delete process.env.SESSION_NAMER_DELAY_MS;
        try {
            await writeConfig({ renameDelayMs: '5' });
            expect((await loadConfig()).renameDelayMs).toBe(5);
            await writeConfig({ renameDelayMs: false });
            expect((await loadConfig()).renameDelayMs).toBe(10000);
        } finally {
            process.env.SESSION_NAMER_DELAY_MS = saved;
        }
    });

    it('coerces prLinkLlm (boolean only)', async () => {
        await writeConfig({});
        expect((await loadConfig()).prLinkLlm).toBe(false);
        await writeConfig({ prLinkLlm: 'yes' });
        expect((await loadConfig()).prLinkLlm).toBe(false);
        await writeConfig({ prLinkLlm: true });
        expect((await loadConfig()).prLinkLlm).toBe(true);
    });

    it('falls back when template or agKeyPattern is an empty string', async () => {
        await writeConfig({ template: '', agKeyPattern: '' });
        const cfg = await loadConfig();
        expect(cfg.template).toBe('[{project}] {agKey} {title}');
        expect(cfg.agKeyPattern).toBe('[A-Z][A-Z0-9]{1,9}-\\d+');
    });

    it('coerces the env delay override like the file keys', async () => {
        const saved = process.env.SESSION_NAMER_DELAY_MS;
        process.env.SESSION_NAMER_DELAY_MS = '0';
        try {
            await writeConfig({});
            expect((await loadConfig()).renameDelayMs).toBe(10000);
        } finally {
            process.env.SESSION_NAMER_DELAY_MS = saved;
        }
    });
});

describe('findPrUrl (PR-link extraction)', () => {
    it('matches a bare pull URL and tolerates path/query/fragment suffixes', () => {
        const pr = {
            host: 'https://github.com',
            owner: 'AdGuardSoftwareLimited',
            repo: 'vpn-extension',
            number: '5',
        };
        const base = 'https://github.com/AdGuardSoftwareLimited/vpn-extension/pull/5';
        expect(findPrUrl(`review ${base}`)).toEqual(pr);
        expect(findPrUrl(`review ${base}/changes`)).toEqual(pr);
        expect(findPrUrl(`review ${base}/files`)).toEqual(pr);
        expect(findPrUrl(`review ${base}#diff-abc123R95`)).toEqual(pr);
        expect(findPrUrl(`review ${base}?foo=bar`)).toEqual(pr);
        expect(findPrUrl(`review ${base}/`)).toEqual(pr);
    });

    it('finds the link deep inside a long expanded prompt (no head window)', () => {
        const pad = 'filler text with no links. '.repeat(200);
        const text = `${pad} https://github.com/o/r/pull/42 ${pad}`;
        expect(findPrUrl(text)).toEqual({
            host: 'https://github.com', owner: 'o', repo: 'r', number: '42',
        });
    });

    it('matches the short owner/repo#N form and markdown inline links', () => {
        expect(findPrUrl('see AdGuardSoftwareLimited/vpn-extension#5 please'))
            .toEqual({
                host: 'https://github.com',
                owner: 'AdGuardSoftwareLimited',
                repo: 'vpn-extension',
                number: '5',
                shortForm: true,
            });
        expect(findPrUrl('[the PR](https://github.com/o/r/pull/7) here'))
            .toEqual({
                host: 'https://github.com', owner: 'o', repo: 'r', number: '7',
            });
    });

    it('returns null for no PR and for non-numeric placeholders', () => {
        expect(findPrUrl('just refactor the code')).toBeNull();
        expect(findPrUrl('placeholder OWNER/REPO#ID')).toBeNull();
    });
});

describe('pr-link LLM fallback', () => {
    it('extracts the PR via a child session when no URL-shaped link is present', async () => {
        await writeConfig({ prLinkLlm: true });
        const session = freshSession({ directory: gitProject });
        const { client, updates, childCalls } = makeClient({
            session,
            firstUserText:
                'please review the filters registry pull request one two two six',
            shortenReply: PR_URL,
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { updates });
        const title = updates[0]?.body.title ?? '';
        expect(childCalls.created).toBeGreaterThan(0);
        expect(title).toContain('[filters registry]');
        expect(title).toContain('Review pull/1226');
    });

    it('ignores an unparseable LLM reply and names by project', async () => {
        await writeConfig({ prLinkLlm: true });
        const session = freshSession({ directory: gitProject });
        const { client, updates, childCalls } = makeClient({
            session,
            firstUserText: 'refactor the parser pipeline',
            shortenReply: 'I could not determine a specific pull request.',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { updates });
        const title = updates[0]?.body.title ?? '';
        expect(childCalls.created).toBeGreaterThan(0);
        expect(title).not.toContain('Review pull');
        expect(title).toContain('[browser-extension]');
    });

    it('does not call the LLM when the regex already found the link', async () => {
        await writeConfig({ prLinkLlm: true });
        const session = freshSession({ directory: gitProject });
        const { client, updates, childCalls } = makeClient({
            session,
            firstUserText: `review this: ${PR_URL}/changes`,
            shortenReply: 'https://github.com/other/should-not-be-used/pull/1',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await drive(hooks, session, { updates });
        const title = updates[0]?.body.title ?? '';
        expect(childCalls.created).toBe(0);
        expect(title).toContain('Review pull/1226');
    });
});
