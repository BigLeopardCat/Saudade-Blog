import {fireEvent, render, screen, act} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import LanguageSwitcher from '../../src/components/LanguageSwitcher';
import {LOCALE_EVENT, LOCALE_KEY, readLocale, setLocale, t, useLocale} from '../../src/i18n';
import {RoleBadge} from '../../src/components/RoleBadge';

function PublicFixture() {
    useLocale();
    return <><LanguageSwitcher /><h1>{t('首页')}</h1><input aria-label="draft" defaultValue="中文草稿" />
        <article>首页 — 用户原文不翻译</article></>;
}

describe('interface language', () => {
    it('switches without remounting a draft or translating article text', () => {
        render(<PublicFixture />);
        const draft = screen.getByRole('textbox');
        fireEvent.change(draft, {target: {value: '继续编辑 my draft'}});
        fireEvent.click(screen.getByRole('button', {name: 'Switch to English'}));
        expect(screen.getByRole('heading').textContent).toBe('Home');
        expect(screen.getByRole('textbox')).toBe(draft);
        expect((draft as HTMLInputElement).value).toBe('继续编辑 my draft');
        expect(screen.getByText('首页 — 用户原文不翻译')).toBeTruthy();
        expect(document.documentElement.lang).toBe('en');
        expect(localStorage.getItem(LOCALE_KEY)).toBe('en');
        fireEvent.click(screen.getByRole('button', {name: '切换为中文'}));
        expect(screen.getByRole('heading').textContent).toBe('首页');
    });

    it('restores an explicit choice and accepts widget/tab changes', () => {
        localStorage.setItem(LOCALE_KEY, 'en');
        expect(readLocale()).toBe('en');
        render(<PublicFixture />);
        act(() => {
            window.__SAUDADE_LOCALE__ = 'zh-CN';
            window.dispatchEvent(new CustomEvent(LOCALE_EVENT, {detail: {locale: 'zh-CN'}}));
        });
        expect(screen.getByRole('heading').textContent).toBe('首页');
        act(() => {
            localStorage.setItem(LOCALE_KEY, 'en');
            window.dispatchEvent(new StorageEvent('storage', {key: LOCALE_KEY, newValue: 'en'}));
        });
        expect(screen.getByRole('heading').textContent).toBe('Home');
    });

    it('still switches when browser storage is unavailable', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {throw new Error('denied');});
        render(<PublicFixture />);
        fireEvent.click(screen.getByRole('button', {name: 'Switch to English'}));
        expect(screen.getByRole('heading').textContent).toBe('Home');
        expect(readLocale()).toBe('en');
    });

    it('formats a complete sentence and preserves substituted content', () => {
        setLocale('en');
        expect(t('第 {page} 页，本页 {count} 条，共 {total} 条', {page: 2, count: 1, total: 4}))
            .toBe('Page 2 · Results: 1 of 4');
        expect(t('分类-{0}', {0: '首页'})).toBe('Category — 首页');
    });

    it('keeps unknown roles as plain labels when switching languages', () => {
        setLocale('en');
        const {container} = render(<RoleBadge role="__proto__" />);
        expect(container.textContent).toContain('__proto__');
    });
});
