import {useSyncExternalStore} from 'react';
import {english} from './messages';

export type Locale = 'zh-CN' | 'en';
export const LOCALE_KEY = 'saudade.locale';
export const LOCALE_EVENT = 'saudade:locale-change';

declare global {
    interface Window { __SAUDADE_LOCALE__?: Locale }
}

const valid = (value: unknown): value is Locale => value === 'zh-CN' || value === 'en';
const browserLocale = (): Locale => {
    if (typeof navigator === 'undefined') return 'zh-CN';
    for (const language of navigator.languages || [navigator.language]) {
        if (/^zh(?:-|$)/i.test(language)) return 'zh-CN';
        if (/^en(?:-|$)/i.test(language)) return 'en';
    }
    return 'zh-CN';
};

export function readLocale(): Locale {
    if (typeof window === 'undefined') return 'zh-CN';
    if (valid(window.__SAUDADE_LOCALE__)) return window.__SAUDADE_LOCALE__;
    let saved: string | null = null;
    try { saved = localStorage.getItem(LOCALE_KEY); } catch { /* Private browsing can deny storage. */ }
    return window.__SAUDADE_LOCALE__ = valid(saved) ? saved : browserLocale();
}

export function setLocale(locale: Locale): void {
    if (!valid(locale)) return;
    window.__SAUDADE_LOCALE__ = locale;
    document.documentElement.lang = locale;
    try { localStorage.setItem(LOCALE_KEY, locale); } catch { /* The current tab still switches. */ }
    window.dispatchEvent(new CustomEvent(LOCALE_EVENT, {detail: {locale}}));
}

export function subscribeLocale(listener: () => void): () => void {
    const changed = () => {
        document.documentElement.lang = readLocale();
        listener();
    };
    const stored = (event: StorageEvent) => {
        if (event.key !== LOCALE_KEY && event.key !== null) return;
        window.__SAUDADE_LOCALE__ = valid(event.newValue) ? event.newValue : undefined;
        changed();
    };
    window.addEventListener(LOCALE_EVENT, changed);
    window.addEventListener('storage', stored);
    return () => {
        window.removeEventListener(LOCALE_EVENT, changed);
        window.removeEventListener('storage', stored);
    };
}

export const useLocale = (): Locale => useSyncExternalStore<Locale>(subscribeLocale, readLocale, () => 'zh-CN');

// Keys are application-owned UI copy. Never pass article bodies or user messages here.
export function t(key: string, values: Record<string, string | number> = {}): string {
    let text = readLocale() === 'en' && Object.prototype.hasOwnProperty.call(english, key) ? english[key] : key;
    // Existing pure quota formatters remain language-neutral dependencies of business code.
    if (readLocale() === 'en') {
        const balance = key.match(/^剩 ([\d.]+) \/ ([\d.]+)$/);
        const used = key.match(/^已用 ([\d.]+) 轮$/);
        if (balance) text = `Remaining: ${balance[1]} / ${balance[2]}`;
        if (used) text = `Turns used: ${used[1]}`;
    }
    return text.replace(/\{(\w+)\}/g, (match, name: string) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
}
