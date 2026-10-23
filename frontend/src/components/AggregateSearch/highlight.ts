/** Literal matches become React text/mark nodes, never HTML supplied by a result. */
export function highlightParts(text: string, terms: readonly string[]) {
    const words = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
    if (!words.length) return [{ text, match: false }];
    const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(words.map(escape).join('|'), 'giu');
    const parts: { text: string; match: boolean }[] = [];
    let start = 0;
    for (const hit of text.matchAll(pattern)) {
        const index = hit.index;
        if (index > start) parts.push({ text: text.slice(start, index), match: false });
        parts.push({ text: hit[0], match: true });
        start = index + hit[0].length;
    }
    if (start < text.length) parts.push({ text: text.slice(start), match: false });
    return parts;
}
