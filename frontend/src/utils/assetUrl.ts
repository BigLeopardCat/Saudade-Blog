const FORBIDDEN_PUNCT = /[\s"'<>()\\]/

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
