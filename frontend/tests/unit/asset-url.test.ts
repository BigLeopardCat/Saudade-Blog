import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { encodeAssetUrl } from '../../src/utils/assetUrl';

// Derive the AST from the actual parser instead of an undeclared transitive @types/mdast version.
const parser = unified().use(remarkParse);
type MarkdownNode = ReturnType<typeof parser.parse> | ReturnType<typeof parser.parse>['children'][number];
function imageCount(markdown: string): number {
    function count(node: MarkdownNode): number {
        let total = node.type === 'image' ? 1 : 0;
        if ('children' in node) for (const child of node.children) total += count(child);
        return total;
    }
    return count(parser.parse(markdown));
}

describe('uploaded asset URLs', () => {
    it.each([
        ['', ''],
        ['/api/protect/download/20260912013218_EMQX.png', '/api/protect/download/20260912013218_EMQX.png'],
        ['https://img.example.com/gallery/sunset.png', 'https://img.example.com/gallery/sunset.png'],
        ['/a/b c.png', '/a/b%20c.png'],
        ['/a/b(1).png', '/a/b%281%29.png'],
        ['/a/x"y\'z.png', '/a/x%22y%27z.png'],
        ['/a/x<y>z.png', '/a/x%3Cy%3Ez.png'],
        ['/a/x\\y.png', '/a/x%5Cy.png'],
        ['/a/x\ty.png', '/a/x%09y.png'],
        ['/api/my dir/a b/c d.png', '/api/my dir/a b/c%20d.png'],
        ['/a/b.png?v=2&x=1 2', '/a/b.png?v=2&x=1%202'],
        ['/a/b.png#frag x', '/a/b.png#frag%20x'],
        ['/a/中文（终稿）.png', '/a/中文（终稿）.png'],
    ])('encodes only the filename destination: %s', (input, output) => {
        expect(encodeAssetUrl(input)).toBe(output);
        expect(encodeAssetUrl(output)).toBe(output);
    });

    it('preserves existing escapes and full-width punctuation after repeated gallery insertion', () => {
        const encoded = encodeAssetUrl('/api/protect/download/满月 (1) 副本（终稿）.png');
        expect(encoded).toBe('/api/protect/download/满月%20%281%29%20副本（终稿）.png');
        expect(encodeAssetUrl(encoded)).toBe(encoded);
        expect(encodeAssetUrl('/a/b%20c.png')).toBe('/a/b%20c.png');
    });

    it('produces a real CommonMark image where the unescaped upload is plain text', () => {
        const raw = '/api/protect/download/20261006033033_把图片的瞳孔颜色 注意：眼.png';
        expect(imageCount(`![](${raw})`)).toBe(0);
        const encoded = encodeAssetUrl(raw);
        expect(imageCount(`![](${encoded})`)).toBe(1);
        expect(imageCount(`\n![](${encoded})`)).toBe(1);
        const tree = unified().use(remarkParse).parse(`![](${raw})`);
        expect(tree.children[0]).toMatchObject({ type: 'paragraph', children: [{ type: 'text' }] });
    });
});
