import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    base: '/',
    mode: 'production',
    plugins: [
        react(),
    ],

    build: {
        cssCodeSplit: true,
        terserOptions: {
            compress: {
                drop_console: true,
                drop_debugger: true,
            }
        },
        assetsDir: 'assets',
        assetsInlineLimit: 4096,
        sourcemap: false,
        reportCompressedSize: false,
        rollupOptions: {
            output: {
                chunkFileNames: 'vendor/[name]-[hash].js',
                entryFileNames: 'js/[name]-[hash].js',
                assetFileNames: '[ext]/[name]-[hash].[ext]',
                manualChunks: {
                    'react-vendor': ['react', 'react-dom'],
                },
            },
        }
    },
});
