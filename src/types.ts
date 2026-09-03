import type { Plugin } from '@opencode-ai/plugin';

/** The SDK client opencode hands to the plugin. */
export type PluginClient = Parameters<Plugin>[0]['client'];

/** Leveled logger bound to the opencode app log. */
export type LogFn = (
    level: 'info' | 'warn' | 'error',
    message: string,
    extra?: Record<string, unknown>,
) => void;

export interface PluginConfig {
    template: string;
    prPrefix: string;
    agKeyPattern: string;
    maxLength: number;
    smartShorten: boolean;
    smartShortenModel: string | null;
    renameDelayMs: number;
}

export interface PrLink {
    host: string;
    owner: string;
    repo: string;
    number: string;
}

export interface ProjectInfo {
    label: string;
    agKey: string | null;
}

export interface PrInfo {
    title: string | null;
    branch: string | null;
}

export interface State {
    processed: Record<string, number>;
}

export interface TrackedSession {
    sawUserMessage: boolean;
    autoTitle: string | undefined;
    foreign: boolean;
    scheduled: boolean;
    lastTitle: string | undefined;
}

/** Extracts an issue key (e.g. AG-123) from free text. */
export type AgKeyExtractor = (
    text: string | null | undefined,
) => string | null;
