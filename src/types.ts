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
 * Inferred from the zod validation schema in `config.ts` so the shape and
 * its coercion rules live in one place.
 */
export type { PluginConfig } from './config';

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
     * Issue key from the worktree branch, when detectable.
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
}

/**

 * Extracts an issue key (e.g. AG-123) from free text.

 */
export type AgKeyExtractor = (
    text: string | null | undefined,
) => string | null;
