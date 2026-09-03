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
import type { PluginConfig } from '../src/config';

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
/**
 * The SDK client type the plugin receives.
 */
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
        userTexts,
    } = options;
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
        await new Promise((r) => {
            setTimeout(r, 100);
        });
    }
    return cond();
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
    const freshRec = (): import('../src/types').TrackedSession => ({
        sawUserMessage: false,
        autoTitle: undefined,
        foreign: false,
        scheduled: false,
        lastTitle: undefined,
    });

    const applyTo = (rec: ReturnType<typeof freshRec>, patch: {
        autoTitle: string | undefined;
        foreign: boolean;
        lastTitle: string;
    }) => {
        rec.lastTitle = patch.lastTitle;
        rec.autoTitle = patch.autoTitle;
        rec.foreign = patch.foreign;
    };

    const classify = async (
        rec: ReturnType<typeof freshRec>,
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
        await hooks.event?.({
            event: { type: 'session.created', properties: { info: { ...session } } },
        } as never);
        await hooks.event?.({
            event: { type: 'session.idle', properties: { sessionID: session.id } },
        } as never);
        await new Promise((r) => {
            setTimeout(r, 400);
        });
        expect(updates).toHaveLength(0);
        expect(session.title).toBe('New session - 2026-09-03T10:00:00.000Z');
        sent = true;
        await hooks.event?.({
            event: {
                type: 'message.updated',
                properties: { info: { role: 'user', sessionID: session.id } },
            },
        } as never);
        session.title = 'Fixing the flaky test';
        await hooks.event?.({
            event: {
                type: 'session.updated',
                properties: { info: { ...session } },
            },
        } as never);
        await hooks.event?.({
            event: { type: 'session.idle', properties: { sessionID: session.id } },
        } as never);
        await waitFor(() => updates.length > 0);
        expect(updates[0]?.body.title).toBe('[browser-extension] Fixing the flaky test');
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
        await hooks.event?.({
            event: { type: 'session.created', properties: { info: { ...session } } },
        } as never);
        await hooks.event?.({
            event: {
                type: 'message.updated',
                properties: { info: { role: 'user', sessionID: session.id } },
            },
        } as never);
        session.title = 'Review pull request';
        await hooks.event?.({
            event: {
                type: 'session.updated',
                properties: { info: { ...session } },
            },
        } as never);
        await hooks.event?.({
            event: { type: 'session.idle', properties: { sessionID: session.id } },
        } as never);
        await waitFor(() => updates.length > 0);
        expect(updates[0]?.body.title).toContain('pull/1226');
    }, 30000);
});

describe('fast message-triggered rename', () => {
    it('renames on the first user message without waiting for idle', async () => {
        await writeConfig({});
        const session = freshSession({ directory: gitProject });
        const { client, updates } = makeClient({
            session,
            firstUserText: 'fix the thing',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        await hooks.event?.({
            event: { type: 'session.created', properties: { info: { ...session } } },
        } as never);
        await hooks.event?.({
            event: {
                type: 'message.updated',
                properties: { info: { role: 'user', sessionID: session.id } },
            },
        } as never);
        // no idle event at all
        await waitFor(() => updates.length > 0);
        expect(updates[0]?.body.title).toBe(
            '[browser-extension] Fixing the flaky test'.includes('fix')
                ? updates[0]?.body.title
                : updates[0]?.body.title,
        );
        expect(updates[0]?.body.title).toBe('[browser-extension] fix the thing');
    });

    it('re-applies our title once when the auto-title lands after the rename', async () => {
        await writeConfig({});
        const session = freshSession({ directory: gitProject });
        const { client, updates } = makeClient({
            session,
            firstUserText: 'fix the thing',
        });
        const hooks = await SessionNamer({ client } as Ctx);
        const emit = async (event: unknown) => {
            await hooks.event?.({ event: event as never });
        };
        await emit({
            type: 'session.created',
            properties: { info: { ...session } },
        });
        await emit({
            type: 'message.updated',
            properties: { info: { role: 'user', sessionID: session.id } },
        });
        await waitFor(() => updates.length > 0);
        const ours = updates[0]?.body.title ?? '';
        expect(ours).toBe('[browser-extension] fix the thing');
        // the built-in auto-title lands late, before the first idle
        session.title = 'Fixing the thing';
        await emit({
            type: 'session.updated',
            properties: { info: { ...session } },
        });
        await waitFor(() => updates.length > 1);
        expect(updates[1]?.body.title).toBe(ours);
        // a second change is left alone (single correction window)
        session.title = 'auto-title landed twice?';
        await emit({
            type: 'session.updated',
            properties: { info: { ...session } },
        });
        await new Promise((r) => {
            setTimeout(r, 300);
        });
        expect(updates).toHaveLength(2);
        expect(session.title).toBe('auto-title landed twice?');
        // after the first idle the window is closed entirely
        await emit({ type: 'session.idle', properties: { sessionID: session.id } });
        session.title = 'manual rename after idle';
        await emit({
            type: 'session.updated',
            properties: { info: { ...session } },
        });
        await new Promise((r) => {
            setTimeout(r, 300);
        });
        expect(updates).toHaveLength(2);
        expect(session.title).toBe('manual rename after idle');
    });
});

describe('loadConfig (zod coercion)', () => {
    // Imported lazily (after the top-level beforeAll has loaded config.ts
    // against the tmp SESSION_NAMER_CONFIG) so the module-level CONFIG_FILE
    // resolves to the test file, not the real user config.
    let loadConfig: () => Promise<PluginConfig>;
    beforeAll(async () => {
        loadConfig = (await import('../src/config')).loadConfig;
    });

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
            // eslint-disable-next-line no-await-in-loop
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
});
