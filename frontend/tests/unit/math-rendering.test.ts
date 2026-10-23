import {describe, expect, it} from 'vitest';
import {waitFor} from '@testing-library/dom';
import {renderBlogMarkdown, enhanceChatContent} from '../../src/utils/chatMarkdown';

describe('shared Markdown formula rendering', () => {
    it('renders inline and display formulas through the actual KaTeX enhancer', async () => {
        const root = document.createElement('div');
        root.innerHTML = renderBlogMarkdown('行内 $x^2$\n\n$$\ny = \\frac{1}{2}\n$$');
        expect(root.querySelector('span.math.math-inline')).not.toBeNull();
        expect(root.querySelector('div.math.math-display')).not.toBeNull();
        expect(root.querySelector('pre')).toBeNull();
        // jsdom has no layout-backed innerText; provide the browser text value on these nodes.
        root.querySelectorAll<HTMLElement>('.math').forEach(el => Object.defineProperty(el, 'innerText', {value: el.textContent}));
        enhanceChatContent(root);
        await waitFor(() => expect(root.querySelectorAll('.katex')).toHaveLength(2));
        expect(root.querySelector('.katex-display')).not.toBeNull();
        expect(root.querySelector('.code-block-head')).toBeNull();
    });
    it('leaves formula-like text inside code as code and strips unsafe HTML', () => {
        const root = document.createElement('div');
        root.innerHTML = renderBlogMarkdown('`$x$`\n\n```tex\n$$x$$\n```\n\n<img src=x onerror="alert(1)">');
        expect(root.querySelector('.math')).toBeNull();
        expect(root.querySelectorAll('code')).toHaveLength(2);
        expect(root.querySelector('[onerror]')).toBeNull();
    });
});
