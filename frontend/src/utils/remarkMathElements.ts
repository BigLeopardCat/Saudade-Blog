/** Keep the DOM contract consumed by the shared KaTeX enhancer and article styles.
 * remark-math 6 emits pre/code; the enhancer expects span/div.math, not code blocks.
 */
export function remarkMathElements() {
    return (tree: unknown) => {
        const visit = (node: unknown) => {
            if (!node || typeof node !== 'object') return;
            if ('type' in node && (node.type === 'math' || node.type === 'inlineMath')
                && 'value' in node && typeof node.value === 'string') {
                const display = node.type === 'math';
                const data = 'data' in node && node.data && typeof node.data === 'object' ? node.data : {};
                Object.assign(node, {data: {
                    ...data,
                    hName: display ? 'div' : 'span',
                    hProperties: {className: ['math', display ? 'math-display' : 'math-inline']},
                    hChildren: [{type: 'text', value: node.value}],
                }});
            }
            if ('children' in node && Array.isArray(node.children)) node.children.forEach(visit);
        };
        visit(tree);
    };
}
