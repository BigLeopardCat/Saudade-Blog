import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/unit/**/*.test.{ts,tsx}'],
        environment: 'jsdom',
        setupFiles: ['tests/setup.ts'],
        restoreMocks: true,
        clearMocks: true,
        unstubGlobals: true,
        unstubEnvs: true,
        testTimeout: 10_000,
        hookTimeout: 10_000,
        // Keep memory bounded on small contributors' hosts.
        maxWorkers: 1,
        allowOnly: false,
    },
});
