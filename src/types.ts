import type { Plugin } from '@opencode-ai/plugin';

/**
 * The SDK client opencode hands to the plugin.
 */
export type PluginClient = Parameters<Plugin>[0]['client'];

/**
 * Leveled logger bound to the opencode app log.
 */
export type LogFn = (
    level: 'info' | 'warn' | 'error',
    message: string,
    extra?: Record<string, unknown>,
) => void;

/**
 * Effective plugin configuration (user file merged over the defaults).
 * Declared here — not in config.ts — so pure type imports never pull the
 * fs/zod/env-carrying config module into the type graph; config.ts keeps
 * its zod schema output assignable to this shape.
 */
export interface PluginConfig {
    /**
     * Name shape. Slots: {project}, {agKey}, {title}; empty slots collapse.
     */
    template: string;
    /**
     * Prepended to {title} for PR sessions; {number} is the PR number.
     */
    prPrefix: string;
    /**
     * Regex for the issue key; an optional capture group selects the key.
     */
    agKeyPattern: string;
    /**
     * Titles longer than this get shortened.
     */
    maxLength: number;
    /**
     * Shorten overlong titles with an LLM instead of a hard word-cut.
     */
    smartShorten: boolean;
    /**
     * provider/model for shortening; null uses opencode's small_model.
     */
    smartShortenModel: string | null;
    /**
     * Ask a small model which PR the first message references when no
     * link-shaped text is found.
     */
    prLinkLlm: boolean;
    /**
     * Delay after the first user message (or first idle) before renaming.
     */
    renameDelayMs: number;
}

/**
 * The subset of SDK session fields the event hook reads.
 */
export interface SessionInfo {
    /**
     * Session id.
     */
    id?: string;
    /**
     * Current session title.
     */
    title?: string;
    /**
     * Session working directory.
     */
    directory?: string;
}

/**
 * A GitHub pull request link parsed out of the first user message.
 */
export interface PrLink {
    /**
     * PR URL origin including scheme, e.g. "https://github.com".
     */
    host: string;
    /**
     * Repository owner (user or org).
     */
    owner: string;
    /**
     * Repository name.
     */
    repo: string;
    /**
     * Pull request number as it appears in the URL.
     */
    number: string;
}

/**
 * Project label and issue key derived from the session directory.
 */
export interface ProjectInfo {
    /**
     * Humanized project name, e.g. "filters registry".
     */
    label: string;
    /**
     * Issue key from the branch, when detectable.
     */
    agKey: string | null;
}

/**
 * Pull request data fetched via the gh CLI.
 */
export interface PrInfo {
    /**
     * PR title.
     */
    title: string | null;
    /**
     * Head branch name (displayId).
     */
    branch: string | null;
}

/**
 * Rename-once persistence state.
 */
export interface State {
    /**
     * Session id → timestamp of when it was processed.
     */
    processed: Record<string, number>;
    /**
     * Session id → the title this plugin applied, kept until the session
     * first goes idle so a late auto-title write can be corrected once.
     */
    appliedTitles: Record<string, string>;
}

/**
 * Per-session in-memory tracking used to recognize the auto-title.
 */
export interface TrackedSession {
    /**
     * Whether a user message was observed for this session.
     */
    sawUserMessage: boolean;
    /**
     * The title the built-in auto-title set, when observed.
     */
    autoTitle: string | undefined;
    /**
     * True when the title was set by anything other than the auto-title
     * (manual rename, another tool) — such sessions are never renamed.
     */
    foreign: boolean;
    /**
     * Whether a rename has already been scheduled for this session.
     */
    scheduled: boolean;
    /**
     * Last title seen in session.updated events.
     */
    lastTitle: string | undefined;
    /**
     * Rename attempts that found no user text; past a cap the session is
     * given up so all-synthetic sessions are not refetched on every idle.
     */
    renameAttempts: number;
}

/**
 * Extracts an issue key (e.g. AG-123) from free text.
 */
export type AgKeyExtractor = (
    text: string | null | undefined,
) => string | null;
