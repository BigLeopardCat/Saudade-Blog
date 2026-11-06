import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),

  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    // 保留显式规则级别和选项，避免 preset 隐式改变检查范围。
    plugins: { 'react-refresh': reactRefresh },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',

      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/globals': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  {
    files: ['tests/**/*.{test,spec}.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.property.name='only'][callee.object.name=/^(test|it|describe)$/]",
        message: 'Do not commit focused tests; run a filtered command instead.',
      }],
    },
  },
])
