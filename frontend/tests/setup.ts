import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Existing behavior fixtures use Chinese, matching the browser matrix's explicit locale.
Object.defineProperty(navigator, 'languages', {configurable: true, value: ['zh-CN']});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
    delete window.__SAUDADE_LOCALE__;
});
