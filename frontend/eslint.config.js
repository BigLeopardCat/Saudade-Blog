// ESLint 扁平配置（20261013，eslint 8.56 → 10.12）。文件名与格式都换了：
//   · 旧：`.eslintrc.cjs`（eslintrc 格式，已删除）
//   · 新：`eslint.config.js`（flat config）。ESLint 9 起它是**唯一**格式，
//     10 里 eslintrc 那一套已经移除 ⇒ 不是"换了个更时髦的写法"，是**没有第二条路**。
// 用 ESM 写（.js 按本目录 package.json 的 `"type": "module"` 解析）。
//
// ⚠️ **这一份是"逐条搬运"，不是"重新挑一遍规则"。** 判据是：升级前后 `npm run lint`
// 报出来的「规则 → 条数」逐条相同。20261013 实测的对照（旧口径 / 新口径）：
//   @typescript-eslint/no-explicit-any              114 / 114   ✅ 一字不差
//   @typescript-eslint/ban-ts-comment                27 /  27   ✅
//   react-hooks/exhaustive-deps                      14 /  14   ✅
//   react-refresh/only-export-components              4 /   3   ← 见下面 rules 里那一段
//   其余全部为 0 的规则不再列出。
// 差值只有两类，都写在下面各自的位置上（react-hooks 的 Compiler 规则族、react-refresh 的一条）。
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // 旧的 `ignorePatterns: ['dist', '.eslintrc.cjs']`。后一项随那个文件一起没了。
  globalIgnores(['dist']),

  {
    // **只有这一族文件进闸。** 旧的 lint 脚本写的是 `eslint . --ext ts,tsx`，
    // 而 flat config 里 `--ext` 已经没了 ⇒ 文件选择改由这里承担。
    //
    // ⚠️ 少了这一行的后果不是"少查几个文件"，是**闸门被悄悄扩到别处**：flat config 里
    // 不带 `files` 的配置块对**所有被遍历到的文件**生效，而 eslint 默认就会遍历
    // `**/*.js` / `**/*.mjs` / `**/*.cjs`（`lib/config/default-config.js` 里那两个
    // "intentionally empty config to ensure these files are globbed by default" 的块）。
    // 本仓 `tests/` 与 `scripts/` 下清一色 .mjs，从来没进过这个闸；不圈住就等于
    // 在这一天把 eslint:recommended 加到它们头上。
    files: ['**/*.{ts,tsx}'],
    // `extends` 是 flat config 里对应的写法（旧的 `extends: [...]` 那三行）。三个都在：
    //   · `js.configs.recommended`      ← 旧的 `eslint:recommended`
    //   · `tseslint.configs.recommended`← 旧的 `plugin:@typescript-eslint/recommended`
    //     （它自带 parser 与 plugin，所以旧的 `parser:` / `plugins: ['@typescript-eslint']`
    //       两行不再需要，那两条 devDependency 也换成了单一入口 `typescript-eslint`）
    //   · `reactHooks.configs.flat.recommended` ← 旧的 `plugin:react-hooks/recommended`
    //     （`configs.recommended` 那一支是 eslintrc 形状，flat 的一面在 `configs.flat` 下）
    //
    // ⚠️ 三个 preset 在 9/10 里都比 8 严，实测**只有两类新命中**，都已逐条处置：
    //   ① ESLint 9 core：`no-useless-assignment` 2 处 → 已在源码里改掉（删掉多余初值）；
    //   ② ESLint 9 core 把 `no-unused-vars` 的 `caughtErrors` 默认从 `'none'` 改成
    //      `'all'`（typescript-eslint 8 跟随）→ 59 处**没用到的 catch 绑定**全线报错，
    //      已在源码里按 ES2019 的 `catch {` 写法清掉（42 个 `e`、12 个 `error`、3 个 `err`、
    //      2 个 `_`）。**这一条不是"为了好看"**：`catch (e) {}` 里的 `e` 是死绑定，
    //      删掉它不可能改变运行期行为（已由 `tsc` + 套件 + `vite build` 三道验证）。
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
    ],
    languageOptions: {
      // 旧的 `env: { browser: true, es2020: true }` 拆成两件事：
      //   · browser → `globals.browser`（就是这一行）
      //   · es2020  → `ecmaVersion`（**这里故意不写**：旧配置下真正决定解析口径的是
      //     `@typescript-eslint/parser` 自己的默认值，而 flat config 的 `ecmaVersion`
      //     默认就是 `'latest'`；照抄 `2020` 反而是一次**收紧**，会让 ES2021+ 的语法
      //     变成解析错误。基线里没有这类报错，说明旧配置也从没按 2020 卡过。）
      // 说句实话：`no-undef` 在 .ts/.tsx 上被 typescript-eslint 关掉了（TS 自己管这个），
      // 所以 `globals.browser` 今天**不产生任何效果**。留着是它表达的是"这些文件跑在浏览器里"
      // 这个仍然为真的意图，且哪天有人把 .js 也圈进来它就立刻有用。
      globals: globals.browser,
    },
    // react-refresh 只出规则、不出 preset：官方 preset 是 `configs.vite`，它给的是
    // `['error', { allowConstantExport: true, allowCompoundComponents: true }]`——
    // 级别比现在高、还多一个**会改变判定范围**的选项。搬的是口径，不是包里的默认值。
    plugins: { 'react-refresh': reactRefresh },
    linterOptions: {
      // 旧的 CLI 开关 `--report-unused-disable-directives`：flat config 里搬到配置里。
      // ⚠️ 必须写成 `'error'`：这个键在 flat config 里的**默认值从 error 变成了 warn**
      // （eslint 的 `lib/config/default-config.js` 里写的是 `1`）⇒ 不写这一行，等于把
      // 一条 error 悄悄降成 warning，而 `npm run lint` 是不加 `--max-warnings 0` 的（见
      // deploy.yml 那段注释）⇒ **它会静默消失**。本仓为"多余的 eslint-disable"吃过一次
      // 亏（那次什么都没部署），这一条就是那时候加的，不能在这一天松开。
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // 20260923：ESLint 变成拦部署的硬闸（CI 的 `check` job）时，这两条从 recommended 的
      // error 降成 warn —— 存量太大（20261013 重数：114 条 no-explicit-any、27 条
      // ban-ts-comment，集中在后台各页的历史写法），而它们**每一条都要动运行时代码**才能
      // 真清掉，一次性做是另一件事。
      // 降级而不是关掉：新代码里再出现时 CI 日志里看得见。**清到 0 再把这两行删掉**。
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',

      // ── react-hooks v4 → v7：`recommended` 里多了一整族 React Compiler 规则 ──
      // 旧的 `plugin:react-hooks/recommended`（v4）只有两条：`rules-of-hooks` error +
      // `exhaustive-deps` warn。v7 的同名 preset 在上面那两条之外**又塞进来 14 条**
      // （`static-components` / `use-memo` / `preserve-manual-memoization` /
      //  `immutability` / `globals` / `refs` / `set-state-in-effect` / `error-boundaries` /
      //  `purity` / `set-state-in-render` / `config` / `gating` / `incompatible-library` /
      //  `unsupported-syntax`），且大多定级 error。20261013 实测其中 5 条当场命中 67 处：
      //
      //   set-state-in-effect 31 · immutability 13 · refs 9 · globals 9 · purity 5
      //
      // 这 67 处**没有一处能机械修**（31 处是"在 effect 里同步 setState"，是 React 官方
      // 都专门写了一篇文章劝退、但改起来要动数据流的重构）。按本仓 20260923 立下的同一口径
      // 处置：**降级到 warn，不关掉**——新代码里再犯，CI 日志里看得见；清到 0 就把这五行删掉。
      // 剩下 9 条今天 0 命中，保持 preset 给的 error 不动（新代码真踩上是应该当场红的）。
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/globals': 'warn',
      'react-hooks/purity': 'warn',

      // ── react-refresh 0.4 → 0.5：命中数 4 → 3，**是包自己放宽的，不是我们改的** ──
      // 旧版把 `src/pages/Dashboard/ContentManage/shared.tsx:65` 的 `aiTip`（一个返回 JSX
      // 的普通箭头函数）算作"非组件的导出"报了 1 条；0.5 不再这么判。
      // 另外 `src/router/index.tsx:33` 的文案变了（新增了 `extraHOCs` 的提示），是同一个
      // 位置、同一条规则。级别与选项都没动：仍是 `warn` + `allowConstantExport`。
    },
  },
])
