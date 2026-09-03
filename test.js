// Mock-client test suite. Run: bun test.js
// PR cases make real `gh` calls (needs gh auth).
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "session-namer-test-"))
process.env.SESSION_NAMER_DELAY_MS = "30"
process.env.SESSION_NAMER_CONFIG = join(tmp, "config.json")
process.env.SESSION_NAMER_STATE = join(tmp, "state.json")

// Portable fixtures: a plain git project and a linked-worktree pair.
// They live next to this file (not in tmp) because the plugin deliberately
// ignores sessions whose directory is inside a temp/scratch location.
const FIXTURES = join(import.meta.dirname, ".test-fixtures")
const gitProject = join(FIXTURES, "browser-extension")
mkdirSync(join(gitProject, ".git"), { recursive: true })
const mainRepo = join(FIXTURES, "main-repo")
const wtGitdir = join(mainRepo, ".git", "worktrees", "fix-AG-56856")
mkdirSync(wtGitdir, { recursive: true })
writeFileSync(join(wtGitdir, "HEAD"), "ref: refs/heads/fix/AG-56856\n")
const worktree = join(FIXTURES, "wt", "fix-AG-56856")
mkdirSync(worktree, { recursive: true })
writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitdir}\n`)

const { $ } = await import("bun")
const { SessionNamer } = await import("./index.js")

let passed = 0
let failed = 0

function writeConfig(cfg) {
  writeFileSync(process.env.SESSION_NAMER_CONFIG, JSON.stringify(cfg))
}

function makeClient({ session, firstUserText, shortenReply }) {
  const updates = []
  const childCalls = { created: 0, prompted: 0, deleted: 0, lastPrompt: null }
  const client = {
    app: { log: async () => {} },
    config: {
      get: async () => ({ data: { small_model: "tokenguard/deepseek-v4-flash" } }),
    },
    session: {
      get: async () => ({ data: session }),
      messages: async ({ path }) => {
        if (path.id.startsWith("child_")) {
          return {
            data: [
              {
                info: { role: "assistant", time: { created: 2 } },
                parts: [{ type: "text", text: shortenReply ?? "shortened" }],
              },
            ],
          }
        }
        return {
          data: [
            {
              info: { role: "user", time: { created: 1 } },
              parts: [{ type: "text", text: firstUserText }],
            },
          ],
        }
      },
      update: async (opts) => {
        updates.push(opts)
        session.title = opts.body.title
        return { data: session }
      },
      create: async () => {
        childCalls.created++
        return { data: { id: "child_" + session.id } }
      },
      prompt: async (opts) => {
        childCalls.prompted++
        childCalls.lastPrompt = opts.body.parts[0].text
        return { data: {} }
      },
      delete: async () => {
        childCalls.deleted++
        return { data: true }
      },
    },
  }
  return { client, updates, childCalls }
}

function freshSession(over = {}) {
  return {
    id: "ses_" + Math.random().toString(36).slice(2, 10),
    title: "New session - 2026-09-03T10:00:00.000Z",
    directory: gitProject,
    parentID: undefined,
    ...over,
  }
}

async function waitFor(cond, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return cond()
}

async function drive(hooks, session, { autoTitle, foreignTitle, updates, expectUpdate = true } = {}) {
  await hooks.event({ event: { type: "session.created", properties: { info: { ...session } } } })
  await hooks.event({ event: { type: "message.updated", properties: { info: { role: "user", sessionID: session.id } } } })
  if (autoTitle) {
    session.title = autoTitle
    await hooks.event({ event: { type: "session.updated", properties: { info: { ...session } } } })
  }
  if (foreignTitle) {
    session.title = foreignTitle
    await hooks.event({ event: { type: "session.updated", properties: { info: { ...session } } } })
  }
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })
  if (expectUpdate) {
    await waitFor(() => updates.length > 0)
  } else {
    await new Promise((r) => setTimeout(r, 800))
  }
  await new Promise((r) => setTimeout(r, 300))
}

async function test(name, fn) {
  try {
    writeConfig({}) // reset to defaults between tests
    await fn()
    passed++
    console.log("PASS", name)
  } catch (e) {
    failed++
    console.log("FAIL", name, "—", e.message)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// 1. GitHub PR link → real gh fetch, repo label, PR title
await test("github PR link gets [repo] Review pull/N + PR title", async () => {
  const session = freshSession()
  const { client, updates } = makeClient({
    session,
    firstUserText: "review this https://github.com/AdguardTeam/FiltersRegistry/pull/1226 please",
  })
  const hooks = await SessionNamer({ client, $ })
  await drive(hooks, session, { autoTitle: "Review pull request", updates })
  assert(updates.length === 1, `expected 1 update, got ${updates.length}`)
  const t = updates[0].body.title
  assert(t.startsWith("[filters registry] Review pull/1226 "), `unexpected title: ${t}`)
  assert(t.length > 40, "PR title missing")
  assert(t.length <= 90, "too long")
  console.log("   →", t)
})

// 2. Review template with EXAMPLE links — must pick the §0 target, not examples
await test("template example links are not picked", async () => {
  const session = freshSession()
  const template = [
    "Review the changeset. Auto-detect from `https://github.com/AdguardTeam/FiltersRegistry/pull/1226`.",
    "",
    ...Array(40).fill("... filler instructions ..."),
    "### Examples",
    "- `https://github.com/AdGuardSoftwareLimited/ext-popup-blocker/pull/10/changes#diff-abcR137`",
    "- `https://github.com/AdguardTeam/compilersite/pull/55/files`",
  ].join("\n")
  const { client, updates } = makeClient({ session, firstUserText: template })
  const hooks = await SessionNamer({ client, $ })
  await drive(hooks, session, { autoTitle: "Review changeset", updates })
  assert(updates.length === 1, `expected 1 update, got ${updates.length}`)
  assert(updates[0].body.title.includes("pull/1226"), `wrong PR picked: ${updates[0].body.title}`)
})

// 3. No PR + git dir + auto-title observed → prefix convention
await test("non-PR session gets [project] prefix on auto-title", async () => {
  const session = freshSession({ directory: gitProject })
  const { client, updates } = makeClient({ session, firstUserText: "почини флакон" })
  const hooks = await SessionNamer({ client, $ })
  await drive(hooks, session, { autoTitle: "Fixing the flaky test", updates })
  assert(updates.length === 1, `expected 1 update, got ${updates.length}`)
  assert(updates[0].body.title === "[browser-extension] Fixing the flaky test", updates[0].body.title)
})

// 4. Worktree → main repo label + AG key from branch (generic .git-file detection)
await test("worktree session gets main-repo label + branch AG key", async () => {
  const session = freshSession({ directory: worktree })
  const { client, updates } = makeClient({ session, firstUserText: "продолжим" })
  const hooks = await SessionNamer({ client, $ })
  await drive(hooks, session, { autoTitle: "Continue stealth fix", updates })
  assert(updates.length === 1, `expected 1 update, got ${updates.length}`)
  assert(updates[0].body.title === "[main-repo] AG-56856 Continue stealth fix", updates[0].body.title)
})

// 5. Manual rename before plugin fires → never touched
await test("manual rename is respected", async () => {
  const session = freshSession()
  const { client, updates } = makeClient({
    session,
    firstUserText: "https://github.com/AdguardTeam/FiltersRegistry/pull/1226",
  })
  const hooks = await SessionNamer({ client, $ })
  await drive(hooks, session, { autoTitle: "Review pull request", foreignTitle: "my custom name", updates, expectUpdate: false })
  assert(updates.length === 0, `expected 0 updates, got ${updates.length}`)
  assert(session.title === "my custom name", session.title)
})

// 6. Small model died (title stays default) → derive from message
await test("default title falls back to message-derived name", async () => {
  const session = freshSession({ directory: gitProject })
  const { client, updates } = makeClient({ session, firstUserText: "почини падающий тест в tsurlfilter\nбольше деталей тут" })
  const hooks = await SessionNamer({ client, $ })
  await drive(hooks, session, { updates })
  assert(updates.length === 1, `expected 1 update, got ${updates.length}`)
  assert(updates[0].body.title === "[browser-extension] почини падающий тест в tsurlfilter", updates[0].body.title)
})

// 7. Scratch dir (openchamber chats) + no PR → untouched
await test("scratch chat dir without PR is left alone", async () => {
  const session = freshSession({ directory: "/home/tester/.config/openchamber/chats/2026-09-03/session-xyz" })
  const { client, updates } = makeClient({ session, firstUserText: "привет, расскажи шутку" })
  const hooks = await SessionNamer({ client, $ })
  await drive(hooks, session, { autoTitle: "Joke request", updates, expectUpdate: false })
  assert(updates.length === 0, `expected 0 updates, got ${updates.length}`)
})

// 8. Second idle never re-renames
await test("second idle does not rename again", async () => {
  const session = freshSession({ directory: gitProject })
  const { client, updates } = makeClient({ session, firstUserText: "сделай фичу" })
  const hooks = await SessionNamer({ client, $ })
  await drive(hooks, session, { autoTitle: "Feature work", updates })
  assert(updates.length === 1, `expected 1 update, got ${updates.length}`)
  session.title = "renamed by user later"
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: session.id } } })
  await new Promise((r) => setTimeout(r, 200))
  assert(updates.length === 1, `expected still 1 update, got ${updates.length}`)
  assert(session.title === "renamed by user later", session.title)
})

// 9. Subagent session is skipped
await test("subagent sessions are skipped", async () => {
  const session = freshSession({ parentID: "ses_parent" })
  const { client, updates } = makeClient({ session, firstUserText: "subtask" })
  const hooks = await SessionNamer({ client, $ })
  await drive(hooks, session, { autoTitle: "Subtask (@explore subagent)", updates, expectUpdate: false })
  assert(updates.length === 0, `expected 0 updates, got ${updates.length}`)
})

// 10. Custom template is honored
await test("custom template + prPrefix", async () => {
  writeConfig({ template: "{project} | {agKey} | {title}", prPrefix: "PR#{number}: " })
  const session = freshSession()
  const { client, updates } = makeClient({
    session,
    firstUserText: "review https://github.com/AdguardTeam/FiltersRegistry/pull/1226",
  })
  const hooks = await SessionNamer({ client, $ })
  await drive(hooks, session, { autoTitle: "Review pull request", updates })
  assert(updates.length === 1, `expected 1 update, got ${updates.length}`)
  const t = updates[0].body.title
  assert(t.startsWith("filters registry | PR#1226: "), `unexpected title: ${t}`)
  console.log("   →", t)
})

// 11. smartShorten: overlong PR title gets LLM-shortened via a throwaway child session
await test("smartShorten shortens overlong titles via child session", async () => {
  writeConfig({ smartShorten: true })
  const session = freshSession()
  const { client, updates, childCalls } = makeClient({
    session,
    firstUserText: "review https://github.com/AdguardTeam/FiltersRegistry/pull/1226",
    shortenReply: "Strip version/timeUpdated fields",
  })
  const hooks = await SessionNamer({ client, $ })
  await drive(hooks, session, { autoTitle: "Review pull request", updates })
  assert(updates.length === 1, `expected 1 update, got ${updates.length}`)
  const t = updates[0].body.title
  assert(t === "[filters registry] Review pull/1226 Strip version/timeUpdated fields", t)
  assert(childCalls.created === 1 && childCalls.prompted === 1 && childCalls.deleted === 1,
    `child lifecycle wrong: ${JSON.stringify(childCalls)}`)
  console.log("   →", t)
})

// 12. smartShorten failure falls back to word truncation
await test("smartShorten failure falls back to truncation", async () => {
  writeConfig({ smartShorten: true })
  const session = freshSession()
  const { client, updates } = makeClient({
    session,
    firstUserText: "review https://github.com/AdguardTeam/FiltersRegistry/pull/1226",
  })
  client.session.create = async () => { throw new Error("boom") }
  const hooks = await SessionNamer({ client, $ })
  await drive(hooks, session, { autoTitle: "Review pull request", updates })
  assert(updates.length === 1, `expected 1 update, got ${updates.length}`)
  const t = updates[0].body.title
  assert(t.length <= 90, `too long: ${t.length}`)
  assert(t.startsWith("[filters registry] Review pull/1226 Strips"), t)
  console.log("   →", t)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
