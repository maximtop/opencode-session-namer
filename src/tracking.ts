import type { TrackedSession } from './types';

const DEFAULT_TITLE_RE = /^New session( - |$)/;

/**
 * The parts of a tracked session that a title change may update.
 */
export interface ChangePatch {
    /**
     * Auto-title recognized from the change, if any.
     */
    autoTitle: string | undefined;
    /**
     * True when the session title is foreign (never rename).
     */
    foreign: boolean;
    /**
     * New last-title baseline.
     */
    lastTitle: string;
}

/**
 * Records what a session title change means for the rename decision and
 * returns the updated tracking fields (pure — the record is not mutated).
 *
 * The first observed title becomes the baseline, whatever its origin —
 * covers sessions whose fact chain started before the plugin loaded.
 * A title set before any user message (picker, another tool) marks the
 * session foreign — never renamed.
 * The first title change after the first user message is treated as the
 * built-in auto-title.
 * A change away from the recorded auto-title is a manual rename — the
 * session becomes foreign too.
 * Residual limitation: a manual rename made before the first reply settles
 * is indistinguishable from the auto-title and gets replaced once.
 * @param rec tracked session state
 * @param newTitle title reported by a session.updated event
 * @returns updated tracking fields
 */
export function classifyTitleChange(
    rec: TrackedSession,
    newTitle: string,
): ChangePatch {
    if (rec.lastTitle === undefined) {
        return {
            autoTitle: rec.autoTitle,
            foreign: rec.foreign,
            lastTitle: newTitle,
        };
    }
    if (rec.lastTitle === newTitle) {
        return {
            autoTitle: rec.autoTitle,
            foreign: rec.foreign,
            lastTitle: rec.lastTitle,
        };
    }
    let { autoTitle, foreign } = rec;
    if (!rec.sawUserMessage) {
        // titled before any user message (picker / manual)
        foreign = true;
    } else if (autoTitle === undefined && !DEFAULT_TITLE_RE.test(newTitle)) {
        // first change after the first user message = the built-in auto-title
        autoTitle = newTitle;
    } else if (autoTitle !== undefined && newTitle !== autoTitle) {
        // changed away from the auto-title = manual rename
        foreign = true;
    }
    return { autoTitle, foreign, lastTitle: newTitle };
}
