/**
 * 把「资源地址」整理成能安全写进 markdown 的形态（20261006 用户第 2 条）。
 *
 * 病根：上传时文件名 = 时间戳 + 原名，**空格原样留着**（用户那张
 * `…把图片2的帽子去掉。 注意：眼….png` 里就有一个半角空格），而插入正文时是裸拼
 * `![](${url})`。CommonMark 的 link destination（不带尖括号的那种）**不允许出现空白
 * 字符** —— 于是整段不是"图片裂了"，而是**退化成纯文本**：渲染出来是一个字面量
 * `![](…)`，一个 `<img>` 都没生成。文件在、后端 `%20` 访问 200，所以既不是文件问题、
 * 也不是解码问题，唯一该修的就是"插进去的那串字符"。
 *
 * ⚠️ **只动最后一个 `/` 之后的那一段**，而且**只编码 CommonMark 的禁区字符**：
 *
 * - 不整串调 `encodeURIComponent`：它会把 `/` 编成 `%2F`（路径当场断掉）、把 `%` 编成
 *   `%25`（`%20` 二次编码成 `%2520`，服务端按字面量找文件 ⇒ 404）。**而且它连单个字符
 *   都靠不住**：`( ) ' ! *` 属于它故意放行的那一档（`!'()*-._~`），而 `(` `)` `'` 恰恰
 *   是 CommonMark 的禁区 —— 拿它当逐字符编码器会漏掉一半。所以下面按码点自己写 `%XX`。
 * - **不碰 `#` 与 `?`**：它们不影响 markdown 解析，但在这条链上是**语法字符**。本函数
 *   按最后一个 `/` 切段，切出来的"文件名"里如果本来带着查询串（`…/x.png?v=2`），
 *   把 `?` 编了就等于把查询串焊进文件名。要动它们得先按 `?#` 切一遍，那是另一件事。
 * - **中文/全角标点一律不动**：CommonMark 只禁空白、控制符与 `"'<>()\`，
 *   非 ASCII 字符完全合法（浏览器发请求时自己会编码），编了只会让正文变得难读。
 * - **跳过 `%`（幂等的关键）**：`isForbidden` 对 `%` 返回 false，所以已经编好的 `%20`
 *   再过一遍仍是 `%20`。这一点是必需的 —— 图库那条路（`ImagePicker.localUpload`）拿到的是
 *   `handleImageUpload` 的返回值、随后又经 `insertImage` 走一遍，同一条 url 会过两次。
 */
const FORBIDDEN_PUNCT = /[\s"'<>()\\]/

/**
 * 这个字符能不能原样留在地址里。
 *
 * 与写法有关的**两条硬约束**：
 *
 * - **控制符必须按码点判，不能写成正则里的 `[\x00-\x1f\x7f]`**：那会撞上 ESLint 的
 *   `no-control-regex`（error），而仓里 `npm run lint` 是 CI `check` job 的一环、
 *   `check` 一红整次部署**不发生**（20261006 实际踩到：改动本身是对的，只是没能上线）。
 *   注意那条规则的 `allow` 选项只豁免**逐个列出**的字符、不认区间，所以只有把区间从正则里
 *   拿掉这一条路。
 * - **`\s` 必须留在正则里**（它没有对应的码点条件），所以判据是"正则 + 码点"两段拼起来的。
 *
 * 顺带的好处：码点判据天生不看 UTF-16 码元 —— 非 BMP 字符（码点 > 0x1f）不可能被误判，
 * 而下面按码点切分的 `Array.from` 也不会把代理对劈成两半。
 */
const isForbidden = (ch: string): boolean => {
    const cp = ch.codePointAt(0)!
    return cp <= 0x1f || cp === 0x7f || FORBIDDEN_PUNCT.test(ch)
}

/* 逐个码点编成 `%XX`（禁区集全是 ASCII 与控制符 ⇒ 两位十六进制一定够）。
   不用 `encodeURIComponent`：它对 `( ) ' ! *` 是**故意不编**的，而那三个标点正是
   CommonMark 的禁区（见文件头）。 */
const pctEncode = (ch: string) =>
    '%' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')

export function encodeAssetUrl(url: string): string {
    if (!url) return url
    const cut = url.lastIndexOf('/')
    const head = url.slice(0, cut + 1)
    const name = url.slice(cut + 1)
    // 按**码点**切（不是按码元），逐字符判
    return head + Array.from(name, (ch) => (isForbidden(ch) ? pctEncode(ch) : ch)).join('')
}

export default encodeAssetUrl
