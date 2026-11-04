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
