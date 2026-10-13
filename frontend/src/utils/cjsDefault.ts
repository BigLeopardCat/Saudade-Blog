/**
 * 从一个 CJS 包里取出它的**默认导出**（组件 / locale 对象 / 函数）。
 *
 * 起因（20261013）：Vite 8 把打包内核从 rollup+esbuild 换成 **Rolldown**，默认 import
 * 一个 CJS 包的取值规则跟着变了（官方迁移文档里叫 "Consistent CommonJS Interop"）。
 * 实测到的机制在产物里能逐字读出来——`vendor/rolldown-runtime-*.js` 那个 `__toESM`：
 *
 *     u=(n,r,o)=>(o=n==null?{}:e(i(n)),
 *        l(r||!n||!n.__esModule||!a.call(n,`default`)
 *            ? t(o,`default`,{value:n,enumerable:!0}) : o, n))
 *
 * `r` 是 isNodeMode，而**这个构建里所有默认 import 都传 1**（产物里写成
 * `X=n(module(),1)`）⇒ 那个条件恒真 ⇒ `X.default === module.exports`（**整个对象**），
 * 而不是 `module.exports.default`。于是：
 *
 *   · `<MarkdownNavbar/>` / `<CountUp/>` / `@mui/icons-material/*` 被当成组件用 ⇒
 *     渲染期炸在 `Element type is invalid … got: object`：
 *
 *         Unexpected Application Error! Minified React error #130; invariant=130&args[]=object
 *         at Xl (vendor/react-vendor-*.js) …
 *
 *   · `antd/lib/locale/zh_CN` 不炸，**只是静默退回英文**（更难看出来的那一半）。
 *
 * 为什么 `Object.keys(那个对象)` 只剩 `["default"]`：包里那句是
 * `Object.defineProperty(e,"__esModule",{value:!0})`，**不可枚举**。
 *
 * 判据 = 「这个包的入口（含子路径入口）里有 `__esModule`」。按它扫全 `src/**` 的默认
 * import，本仓一共 **14 处**：`markdown-navbar`、`react-countup`（两处）、
 * `antd/lib/locale/zh_CN`（两处）、`@mui/icons-material/<Icon>`（九处）。
 * ⚠️ **别只扫包根**：`@mui/icons-material/Add` 这种子路径入口要按文件解析，
 * 只读包根的 `module`/`main` 会把它读成 `esm/index.js`（那里没有 `__esModule`），
 * 于是盘点出来是"只有三个包"——**这正是 20261013 第一版补丁漏掉九个图标的原因**。
 *
 * 三种形态都兜住，**因此不依赖打包器当下选的是哪一条规则**：
 *   ① 拿到名字空间对象（本次实测到的形态）⇒ `mod.default.default`
 *   ② 拿到 `module.exports.default`，也就是组件本身（文档写的规则）⇒ `mod.default`
 *   ③ 拿到组件本身（包直接 `module.exports = Component`）⇒ `mod`
 *
 * ③ 那一路是给"哪天上游修好了 / 换了打包器"留的：**规则修好之后这里不必再改一次**。
 */
export function cjsDefault<T>(mod: T): T {
    const m = mod as unknown as { default?: { default?: unknown } }
    return (m?.default?.default ?? m?.default ?? mod) as T
}
