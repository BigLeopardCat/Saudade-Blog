module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    // 20260923：ESLint 变成拦部署的硬闸（CI 的 `check` job）时，这两条从 recommended 的
    // error 降成 warn —— 存量太大（96 条 no-explicit-any、29 条 ban-ts-comment，集中在后台
    // 各页的历史写法），而它们**每一条都要动运行时代码**才能真清掉，一次性做是另一件事。
    // 降级而不是关掉：新代码里再出现时 CI 日志里看得见。**清到 0 再把这两行删掉**。
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/ban-ts-comment': 'warn',
  },
}
