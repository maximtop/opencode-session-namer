// opencode-session-namer — gives opencode sessions meaningful names.
//
// What it does, once per session, shortly after the first reply settles:
//   First user message contains a GitHub PR link
//     → [<repo>] [<issue-key>] Review pull/<N> <PR title>     (title via `gh`)
//   Otherwise, for sessions inside a git project
//     → [<project>] [<issue-key>] <opencode auto-title>
//
// - The issue key (e.g. AG-123) is taken from the PR branch/title or the
//   current branch — no issue-tracker API calls.
// - Worktrees are detected generically: a linked worktree has a `.git` FILE
//   pointing at the main repo, so the project label is the main repo name and
//   the issue key comes from the branch recorded in the worktree's HEAD.
// - A title set by anything other than the built-in auto-title (manual
//   rename, another tool) marks the session as foreign and it is never
//   renamed. A session is renamed at most once, ever.
// - The rename lands `renameDelayMs` after the first `session.idle` so it is
//   written after the built-in auto-title (in opencode the last write wins).
//
// Config (all optional): ~/.config/opencode/session-namer.json
//   {
//     "template": "[{project}] {agKey} {title}",   // slots: {project} {agKey} {title}
//     "prPrefix": "Review pull/{number} ",          // prepended to {title} for PR sessions
//     "agKeyPattern": "[A-Z][A-Z0-9]{1,9}-\\d+",     // issue key regex
//     "maxLength": 90,
//     "smartShorten": false,                         // LLM-shorten overlong titles
//     "smartShortenModel": null,                     // "provider/model"; default: small_model
//     "renameDelayMs": 10000
//   }

import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join, basename } from "node:path"
import { homedir, tmpdir } from "node:os"

const URL_SCAN_CHARS = 2000
const CONFIG_FILE = process.env.SESSION_NAMER_CONFIG ?? join(homedir(), ".config", "opencode", "session-namer.json")
const STATE_FILE = process.env.SESSION_NAMER_STATE ?? join(homedir(), ".config", "opencode", "session-namer.state.json")
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_TITLE_RE = /^New session( - |$)/

const DEFAULTS = {
  template: "[{project}] {agKey} {title}",
  prPrefix: "Review pull/{number} ",
  agKeyPattern: "[A-Z][A-Z0-9]{1,9}-\\d+",
  maxLength: 90,
  smartShorten: false,
  smartShortenModel: null,
  renameDelayMs: 10000,
}

// ---------- pure helpers ----------

function humanize(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .toLowerCase()
    .trim()
}

function truncateAtWord(text, max) {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(" ")
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()
}

function applyTemplate(template, slots) {
  return template
    .replace(/\{(\w+)\}/g, (_, key) => slots[key] ?? "")
    .replace(/\s*([|—–·•/-])\s*(?=[|—–·•/-])/g, " ") // separator directly before another separator (empty slot)
    .replace(/\s+/g, " ")
    .replace(/\s*[|—–·•/-]\s*$/g, "") // trailing separator after an empty slot
    .trim()
}

// Find the target PR link in the first user message. Review prompt templates
// tend to carry *example* links further down, so scan only the head of the
// message and skip deep links (with #fragments or ?queries).
function findPrUrl(text) {
  const head = text.slice(0, URL_SCAN_CHARS)
  const urls = head.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []
  for (const raw of urls) {
    const u = raw.replace(/[.,;:!?]+$/, "")
    if (u.includes("#") || u.includes("?")) continue
    const m = u.match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/)
    if (m) return { platform: "github", host: m[1], owner: m[2], repo: m[3], number: m[4] }
  }
  return null
}

// Project label from the session directory.
// - Regular checkout: the directory basename.
// - Linked worktree: `.git` is a file whose gitdir points into the main
//   repo's `.git/worktrees/…`, so the label is the main repo name and the
//   issue key comes from the worktree branch (HEAD file).
// - Scratch dirs (chats, tmp, non-git) → null, session keeps the auto-title.
function projectForDirectory(dir, extractAgKey) {
  if (!dir) return null
  if (dir.includes("/.config/openchamber/chats/")) return null
  if (dir.startsWith(tmpdir()) || dir.startsWith("/tmp/") || dir.startsWith("/var/folders/")) return null
  const gitPath = join(dir, ".git")
  let st
  try {
    st = lstatSync(gitPath)
  } catch {
    return null
  }
  if (st.isDirectory()) return { label: humanize(basename(dir)), agKey: null }
  if (!st.isFile()) return null
  try {
    const content = readFileSync(gitPath, "utf8")
    const m = content.match(/gitdir:\s*(.+)/)
    if (!m) return { label: humanize(basename(dir)), agKey: null }
    const gitdir = m[1].trim()
    const wt = gitdir.match(/^(.*?)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/)
    if (!wt) return { label: humanize(basename(dir)), agKey: null } // submodule etc.
    return { label: humanize(basename(wt[1])), agKey: branchAgKey(gitdir, extractAgKey) }
  } catch {
    return { label: humanize(basename(dir)), agKey: null }
  }
}

function branchAgKey(gitdir, extractAgKey) {
  try {
    const head = readFileSync(join(gitdir, "HEAD"), "utf8")
    const m = head.match(/ref:\s*refs\/heads\/(.+)/)
    return m ? extractAgKey(m[1].trim()) : null
  } catch {
    return null
  }
}

function deriveBase(messageText, maxLength) {
  const line = messageText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  return truncateAtWord(line.replace(/\s+/g, " "), Math.min(50, maxLength))
}

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
    return { ...DEFAULTS, ...raw }
  } catch {
    return { ...DEFAULTS }
  }
}

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    const now = Date.now()
    const processed = Object.fromEntries(
      Object.entries(parsed.processed ?? {}).filter(([, ts]) => now - ts < STATE_TTL_MS),
    )
    return { processed }
  } catch {
    return { processed: {} }
  }
}

function saveState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state))
  } catch {
    // best effort
  }
}

// ---------- plugin ----------

export const SessionNamer = async ({ client, $ }) => {
  const log = (level, message, extra) =>
    client.app.log({ body: { service: "session-namer", level, message, extra } }).catch(() => {})

  const config = loadConfig()
  config.renameDelayMs = Number(process.env.SESSION_NAMER_DELAY_MS ?? config.renameDelayMs)
  const agKeyRe = new RegExp(config.agKeyPattern)
  const extractAgKey = (text) => {
    if (!text) return null
    const m = String(text).match(agKeyRe)
    return m ? (m[1] ?? m[0]) : null
  }

  const state = loadState()
  const tracked = new Map()

  const recordFor = (id) => {
    let rec = tracked.get(id)
    if (!rec) {
      rec = { known: false, sawUserMessage: false, autoTitle: undefined, foreign: false, scheduled: false, lastTitle: undefined }
      tracked.set(id, rec)
    }
    return rec
  }

  const markProcessed = (id) => {
    state.processed[id] = Date.now()
    saveState(state)
  }

  async function fetchGhPrInfo(pr) {
    const host = pr.host.replace(/^https?:\/\//, "")
    const out = await (host === "github.com"
      ? $`gh pr view ${pr.number} --repo ${`${pr.owner}/${pr.repo}`} --json title,headRefName`.quiet().nothrow()
      : $`env GH_HOST=${host} gh pr view ${pr.number} --repo ${`${pr.owner}/${pr.repo}`} --json title,headRefName`.quiet().nothrow())
    if (out.exitCode !== 0) return null
    const j = JSON.parse(out.text())
    return { title: j.title ?? null, branch: j.headRefName ?? null }
  }

  async function firstUserText(sessionID, directory) {
    const res = await client.session.messages({ path: { id: sessionID }, query: { directory, limit: 50 } })
    const msgs = res.data ?? []
    const users = msgs
      .filter((m) => m.info?.role === "user")
      .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))
    for (const m of users) {
      const parts = (m.parts ?? []).filter((p) => p.type === "text" && !p.synthetic && p.text?.trim())
      if (parts.length > 0) return parts.map((p) => p.text).join("\n")
    }
    return null
  }

  // LLM-shorten an overlong descriptive part via a throwaway child session.
  // Any failure → caller falls back to word truncation.
  async function smartShorten(text, budget, parentSessionID, directory) {
    let model
    if (config.smartShortenModel) {
      const [providerID, modelID] = config.smartShortenModel.split("/")
      model = { providerID, modelID }
    } else {
      const cfg = await client.config.get()
      const small = cfg.data?.small_model
      if (typeof small === "string" && small.includes("/")) {
        const [providerID, modelID] = small.split("/")
        model = { providerID, modelID }
      }
    }
    const child = await client.session.create({
      body: { parentID: parentSessionID, title: "session-namer: shorten" },
      query: { directory },
    })
    const childID = child.data?.id
    try {
      await client.session.prompt({
        path: { id: childID },
        query: { directory },
        body: {
          ...(model ? { model } : {}),
          parts: [
            {
              type: "text",
              text: `Shorten the following title to at most ${budget} characters. Keep the same language and the key technical terms. Reply with the shortened title only — no quotes, no explanations.\n\n${text}`,
            },
          ],
        },
      })
      const msgs = await client.session.messages({ path: { id: childID }, query: { directory } })
      const reply = (msgs.data ?? [])
        .filter((m) => m.info?.role === "assistant")
        .sort((a, b) => (b.info.time?.created ?? 0) - (a.info.time?.created ?? 0))
        .flatMap((m) => m.parts ?? [])
        .find((p) => p.type === "text" && p.text?.trim())
      const shortened = reply?.text.trim().split("\n")[0].trim()
      if (!shortened) throw new Error("empty shorten reply")
      return shortened.length > budget + 10 ? truncateAtWord(shortened, budget) : shortened
    } finally {
      await client.session.delete({ path: { id: childID }, query: { directory } }).catch(() => {})
    }
  }

  // Compose the final title. When it exceeds maxLength, only the descriptive
  // part is shortened (smartShorten or word-cut) — the structural prefix and
  // keepPrefix (e.g. "Review pull/N ") stay intact.
  async function composeTitle({ project, agKey, keepPrefix = "", desc, sessionID, directory }) {
    const titlePart = keepPrefix + desc
    const full = applyTemplate(config.template, { project, agKey: agKey ?? "", title: titlePart })
    if (full.length <= config.maxLength) return full
    const structural = applyTemplate(config.template, { project, agKey: agKey ?? "", title: keepPrefix.trimEnd() })
    const budget = Math.max(20, config.maxLength - structural.length - 1)
    let shortened = null
    if (config.smartShorten) {
      try {
        shortened = await smartShorten(desc, budget, sessionID, directory)
      } catch (e) {
        log("warn", "smartShorten failed, falling back to truncation", { error: String(e) })
      }
    }
    return applyTemplate(config.template, {
      project,
      agKey: agKey ?? "",
      title: keepPrefix + (shortened ?? truncateAtWord(desc, budget)),
    })
  }

  async function rename(sessionID) {
    if (state.processed[sessionID]) return
    const rec = tracked.get(sessionID)
    if (rec?.foreign) return markProcessed(sessionID)

    const got = await client.session.get({ path: { id: sessionID } })
    const session = got.data
    if (!session) return // transient — try again on a later idle
    if (session.parentID) return markProcessed(sessionID) // subagent sessions name themselves

    const isDefault = DEFAULT_TITLE_RE.test(session.title)
    if (!isDefault) {
      // Replace only the known auto-title. Anything else is a manual/external
      // rename (or an untracked pre-restart session) — leave it alone.
      if (!rec || rec.autoTitle === undefined || session.title !== rec.autoTitle) {
        return markProcessed(sessionID)
      }
    }

    const text = await firstUserText(sessionID, session.directory)
    if (!text) return markProcessed(sessionID)

    let title = null
    const pr = findPrUrl(text)
    if (pr) {
      const project = humanize(pr.repo)
      let info = null
      try {
        info = await fetchGhPrInfo(pr)
      } catch (e) {
        log("warn", "PR fetch failed, naming from URL only", { sessionID, error: String(e) })
      }
      const agKey = extractAgKey(info?.branch) ?? extractAgKey(info?.title)
      // PR titles often start with the issue key ("AG-31699: Add …") — don't
      // repeat it after the prefix.
      const prTitle = info?.title
        ? agKey
          ? info.title.replace(new RegExp(`^${agKey}[:\\s-]*`), "")
          : info.title
        : null
      // prPrefix keeps its trailing space; expand slots without trimming.
      const prefix = config.prPrefix.replace(/\{(\w+)\}/g, (_, k) => ({ number: pr.number })[k] ?? "")
      title = await composeTitle({
        project,
        agKey,
        keepPrefix: prTitle ? prefix : prefix.trimEnd(),
        desc: prTitle ?? "",
        sessionID,
        directory: session.directory,
      })
    } else {
      const dir = projectForDirectory(session.directory, extractAgKey)
      if (dir) {
        const base = isDefault ? deriveBase(text, config.maxLength) : session.title
        if (base && !base.startsWith("[")) {
          title = await composeTitle({
            project: dir.label,
            agKey: dir.agKey,
            desc: base,
            sessionID,
            directory: session.directory,
          })
        }
      }
    }

    if (title && title !== session.title) {
      await client.session.update({ path: { id: sessionID }, query: { directory: session.directory }, body: { title } })
      log("info", "renamed session", { sessionID, title })
    }
    markProcessed(sessionID)
  }

  return {
    event: async ({ event }) => {
      try {
        if (event.type === "session.created") {
          const info = event.properties?.info
          if (info?.id) {
            const rec = recordFor(info.id)
            rec.known = true
            rec.lastTitle = info.title
          }
          return
        }
        if (event.type === "session.updated") {
          const info = event.properties?.info
          if (!info?.id || state.processed[info.id]) return
          const rec = recordFor(info.id)
          if (rec.lastTitle !== undefined && rec.lastTitle !== info.title) {
            if (!rec.sawUserMessage) {
              rec.foreign = true // titled before any user message (picker / manual)
            } else if (rec.autoTitle === undefined) {
              rec.autoTitle = info.title // first title after first user message = auto-title
            } else if (info.title !== rec.autoTitle) {
              rec.foreign = true // changed away from the auto-title = manual rename
            }
          }
          rec.lastTitle = info.title
          return
        }
        if (event.type === "message.updated") {
          const info = event.properties?.info
          if (info?.role === "user" && info.sessionID) recordFor(info.sessionID).sawUserMessage = true
          return
        }
        if (event.type === "session.idle") {
          const sessionID = event.properties?.sessionID
          if (!sessionID || state.processed[sessionID]) return
          const rec = recordFor(sessionID)
          if (rec.foreign || rec.scheduled) return
          rec.scheduled = true
          setTimeout(() => {
            rename(sessionID).catch((e) => log("error", "rename failed", { sessionID, error: String(e) }))
          }, config.renameDelayMs)
        }
      } catch (e) {
        log("error", "event handler failed", { error: String(e) })
      }
    },
  }
}
