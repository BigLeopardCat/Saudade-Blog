/** Bare URLs in prose end at CJK sentence punctuation. Explicit links remain literal. */
export function remarkAutolinkBoundary() {
    return (tree: unknown, file: {value: unknown}) => {
        const source = String(file.value);
        const visit = (node: unknown) => {
            if (!node || typeof node !== 'object' || !('children' in node)
                || !Array.isArray(node.children)) return;
            node.children = node.children.flatMap(child => {
                visit(child);
                if (child.type !== 'link' || typeof child.url !== 'string'
                    || child.children?.length !== 1 || child.children[0].type !== 'text') return [child];
                const start = child.position?.start?.offset;
                const end = child.position?.end?.offset;
                if (typeof start !== 'number' || typeof end !== 'number') return [child];
                const raw = source.slice(start, end);
                // Source offsets distinguish GFM autolinks from [label](url), <url> and references.
                if (!/^(?:https?:\/\/|www\.)/i.test(raw) || raw !== child.children[0].value) return [child];
                const boundary = raw.search(/[，。；：！？、]/u);
                if (boundary < 0) return [child];
                const label = raw.slice(0, boundary);
                const url = /^www\./i.test(label) ? `http://${label}` : label;
                return [{...child, url, children: [{type: 'text', value: label}]},
                    {type: 'text', value: raw.slice(boundary)}];
            });
        };
        visit(tree);
    };
}
