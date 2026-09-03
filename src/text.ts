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
 * Cuts text at the last word boundary before `max` characters.
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
 * Substitutes {slot} placeholders. Separators left dangling by an empty
 * slot (e.g. "|" in "{project} | {agKey} | {title}") are cleaned up.
 * @param template template string with {slot} placeholders
 * @param slots slot values; empty slots collapse
 * @returns rendered string
 */
export function applyTemplate(
    template: string,
    slots: Record<string, string>,
): string {
    return template
        .replace(/\{(\w+)\}/g, (_, key: string) => slots[key] ?? '')
        .replace(/\s*([|—–·•/-])\s*(?=[|—–·•/-])/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s*[|—–·•/-]\s*$/g, '')
        .trim();
}

/**
 * Derives a fallback title from the first line of the user message.
 * @param messageText first user message text
 * @param maxLength length cap for the derived part
 * @returns derived title or null
 */
export function deriveBase(
    messageText: string,
    maxLength: number,
): string | null {
    const line = messageText
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0);
    if (!line) {
        return null;
    }
    return truncateAtWord(line.replace(/\s+/g, ' '), Math.min(50, maxLength));
}
