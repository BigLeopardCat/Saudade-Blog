import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { statCells, STAT_CELL_ORDER } from '../../src/utils/noteStats';
import type { NoteType } from '../../src/interface/NoteType';
import * as icons from '../../src/components/NoteStatIcons';

// Malformed API values are deliberate runtime inputs, not accepted TS DTOs.
const cells = (input: unknown) => statCells(input as Partial<NoteType> | null | undefined);
describe('article statistics retain independent unknown values', () => {
    it.each([undefined, null, {}, { views: undefined }, { views: null }, { views: '0' }, { views: NaN }, { views: Infinity }])('does not turn an absent or invalid count into zero: %j', input => {
        expect(cells(input)).toEqual([]);
    });
    it('shows real zeros in reading, like, favorite and discussion order', () => {
        const result = cells({ comments: 0, favorites: 0, views: 0, likes: 0 });
        expect(result.map(cell => cell.key)).toEqual(['views', 'likes', 'favorites', 'comments']);
        expect(result.map(cell => cell.value)).toEqual([0, 0, 0, 0]);
        expect(result.every(cell => cell.label.length > 0)).toBe(true);
    });
    it('keeps confirmed counts when only some aggregate queries succeed', () => {
        expect(cells({ views: 12 }).map(cell => cell.key)).toEqual(['views']);
        expect(cells({ views: 12, likes: 3, favorites: undefined }).map(cell => cell.key)).toEqual(['views', 'likes']);
        expect(cells({ views: 12, likes: 3, favorites: 1, comments: undefined }).map(cell => cell.key)).toEqual(['views', 'likes', 'favorites']);
    });
});

describe('shared statistics icons and integration contract', () => {
    it.each(Object.entries(icons))('%s renders one theme-colored SVG', (_name, Icon) => {
        const { container } = render(<Icon />);
        expect(container.querySelectorAll('svg')).toHaveLength(1);
        expect(container.innerHTML).toContain('currentColor');
        expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}/i);
        expect(container.textContent).toBe('');
    });
    it('keeps cards and article detail connected to the shared policy and icons', () => {
        // This small source contract intentionally checks ownership across modules;
        // behavior above imports actual modules without esbuild or a DOM emulator.
        const read = (file: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src', file), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const card = read('frontHome/Content/ContentHome/Article.tsx');
        expect(card).toMatch(/statCells\(item\)/);
        expect(card).not.toMatch(/typeof item\.(views|likes|favorites|comments)/);
        expect(card).toMatch(/from\s*["'][^"']*components\/NoteStatIcons/);
        expect(card).toContain('ArticleStatNum');
        expect(card).not.toMatch(/ArticleStat[^>]*style=\{\{/);
        for (const { key } of STAT_CELL_ORDER) expect(card).toMatch(new RegExp(`\\b${key}:\\s*<\\w+Icon`));
        const detail = read('frontHome/Content/ReadArticle/index.tsx');
        expect(detail).toMatch(/from\s*["'][^"']*components\/NoteStatIcons/);
        expect(detail).not.toContain('M1.8 12S5.6 5.5 12 5.5');
    });
});
