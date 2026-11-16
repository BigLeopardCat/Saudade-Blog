import {describe, expect, it} from 'vitest';
import {renderBlogMarkdown} from '../../src/utils/chatMarkdown';

const render = (text: string) => {
    const root = document.createElement('div');
    root.innerHTML = renderBlogMarkdown(text);
    return root;
};

describe('bare URLs in Chinese prose', () => {
    it.each(['，', '。', '；', '：', '！', '？', '、', '）', '］', '】', '》', '」', '』'])('keeps %s and trailing prose outside the destination', punctuation => {
        const url = 'https://example.test/article/62';
        const suffix = `${punctuation}这是助手的介绍`;
        const root = render(`文章：${url}${suffix}`);
        expect(root.querySelector('a')?.getAttribute('href')).toBe(url);
        expect(root.querySelector('a')?.textContent).toBe(url);
        expect(root.textContent).toBe(`文章：${url}${suffix}`);
    });
    it.each([
        '[中文路径](https://example.test/中文，路径)',
        '[中文路径](https://example.test/中文）路径)',
        '<https://example.test/中文，路径>',
        '[中文路径][source]\n\n[source]: https://example.test/中文，路径',
    ])('preserves explicitly delimited destinations: %s', text => {
        const root = render(text);
        const punctuation = text.includes('）') ? '）' : '，';
        expect(decodeURI(root.querySelector('a')!.getAttribute('href')!)).toBe(`https://example.test/中文${punctuation}路径`);
    });
    it('keeps the article source link clickable inside Chinese parentheses', () => {
        const text = '来源：文章22全文（https://example.test/article/22），读取完整。';
        const root = render(text);
        expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.test/article/22');
        expect(root.textContent).toBe(text);
    });
    it('preserves query strings, fragments, encoded punctuation and code', () => {
        const url = 'https://example.test/article/62?q=%EF%BC%8C#section';
        expect(render(`${url}，说明`).querySelector('a')?.getAttribute('href')).toBe(url);
        expect(render('`https://example.test/article/62，说明`').querySelector('a')).toBeNull();
        expect(render('```\nhttps://example.test/article/62，说明\n```').querySelector('a')).toBeNull();
        expect(render('www.example.test，说明').querySelector('a')?.getAttribute('href')).toBe('http://www.example.test');
    });
});
