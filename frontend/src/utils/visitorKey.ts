/** localStorage 键。`saudade.` 前缀与 isDarkMode / lastUser 那几个自建键同族。 */
const VISITOR_KEY_STORAGE = 'saudade.visitorKey'

/** 上报用的请求头名。**后端 `note_stats.rs::VISITOR_HEADER` 必须与它逐字一致**
 *  （全仓只有这两处写这个字符串：改一处就得改另一处）。 */
export const VISITOR_HEADER = 'X-Visitor-Key'

/** 服务端白名单：长度 8–64、字符集 `[A-Za-z0-9_-]`。**这里是它的前端副本**，
 *  用途只有一个——判断本机存的那个值还能不能用（被手工改短/改脏时重新生成）。 */
export function isValidVisitorKey(k: string): boolean {
    return k.length >= 8 && k.length <= 64 && /^[A-Za-z0-9_-]+$/.test(k)
}

/** 造一个新标识。优先 `crypto.randomUUID`（https / localhost 下都有）；
 *  没有就退到 `getRandomValues`，再没有（老浏览器）才退到 `Math.random`
 *  ——它足够当一个去重键（不参与安全判定，见纪律 1）。 */
function makeKey(): string {
    // 只声明**用得到的那两个方法**（而不是 `as any`）：老浏览器上它们可能缺席，
    // 类型上写成可选正合事实。
    type MaybeCrypto = {
        randomUUID?: () => string
        getRandomValues?: (b: Uint8Array) => Uint8Array
    }
    const c = (globalThis as { crypto?: MaybeCrypto }).crypto
    if (c && typeof c.randomUUID === 'function') return c.randomUUID()
    if (c && typeof c.getRandomValues === 'function') {
        const b = new Uint8Array(16)
        c.getRandomValues(b)
        return Array.from(b, (x: number) => x.toString(16).padStart(2, '0')).join('')
    }
    return 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** localStorage 不可用（隐私模式）时的兜底：**进程内一份**，同一页里的多次请求
 *  仍然认得出是同一台浏览器；刷新即变，等价于"换了个访客"。 */
let ephemeral: string | null = null

/** 取本浏览器的匿名标识（没有就生成并记住）。**永远返回一个合法值**。 */
export function getVisitorKey(): string {
    try {
        const cur = localStorage.getItem(VISITOR_KEY_STORAGE)
        if (cur && isValidVisitorKey(cur)) return cur
        const next = makeKey()
        localStorage.setItem(VISITOR_KEY_STORAGE, next)
        return next
    } catch {
        if (!ephemeral) ephemeral = makeKey()
        return ephemeral
    }
}
