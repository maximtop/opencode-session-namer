/**
 * Turns a directory or repo name into a display label:
 * "FiltersRegistry" → "filters registry", "browser-extension" stays as is.
 * @param name raw directory or repository name
 * @returns display label
 */
export function humanize(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/_+/g, ' ')
        .toLowerCase()
        .trim();
}

/**
 * Cuts text to `max` characters, preferring the last word boundary in the
 * second half of the window; hard-cuts mid-word when no such boundary exists.
 * @param text text to cut
 * @param max maximum length
 * @returns cut text
 */
export function truncateAtWord(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    const cut = text.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    const head = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
    return head.trimEnd();
}

/**
 * Substitutes {slot} placeholders without whitespace normalization. An
 * empty slot drops the separator that follows it; every other byte stays
 * exactly as written. Used where the surrounding text must keep its exact
 * spacing (e.g. prPrefix' trailing space).
 * @param template template string with {slot} placeholders
 * @param slots slot values; unknown slots render empty
 * @returns rendered string
 */
export function expandSlots(
    template: string,
    slots: Record<string, string>,
): string {
    const pieces = template.split(/\{(\w+)\}/);
    let out = pieces[0] ?? '';
    const slotCount = Math.floor(pieces.length / 2);
    for (let k = 0; k < slotCount; k += 1) {
        const key = pieces[2 * k + 1];
        const value = key !== undefined ? (slots[key] ?? '') : '';
        if (value) {
            out += value + (pieces[2 * k + 2] ?? '');
        }
    }
    return out;
}

/**
 * Substitutes {slot} placeholders. A slot renders together with the
 * separator that follows it, so an empty slot drops exactly one separator
 * ("{a}|{b}|{c}" with an empty b renders as "a|c"). Result is whitespace-
 * normalized and trimmed.
 * @param template template string with {slot} placeholders
 * @param slots slot values; empty slots collapse
 * @returns rendered string
 */
export function applyTemplate(
    template: string,
    slots: Record<string, string>,
): string {
    return expandSlots(template, slots).replace(/\s+/g, ' ').trim();
}

/**
 * Derives a fallback title from the first line of the user message.
 * @param text first user message text
 * @param maxLength length cap for the derived part
 * @returns derived title or null
 */
export function deriveBase(
    text: string,
    maxLength: number,
): string | null {
    const line = text
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
    if (!line) {
        return null;
    }
    return truncateAtWord(line.replace(/\s+/g, ' '), Math.min(50, maxLength));
}
