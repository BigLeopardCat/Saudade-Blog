/** 余额档位。`unlimited` 与 `null`（读不到）不是档位，是两种别的事实。 */
export type QuotaLevel = 'ok' | 'low' | 'critical' | 'empty' | 'unlimited'

/** 低于这个比例算"偏低"。 */
export const QUOTA_LOW_RATIO = 0.2
/** 高于这个比例才算"充足"。 */
export const QUOTA_OK_RATIO = 0.5

const isNum = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v)

/**
 * 余额档位；`null` = 这两个数现在读不到（**不是**"用完了"——调用方要自己给"读不到"
 * 的形态，别拿 `empty` 冒充）。`limit <= 0` ⇒ `'unlimited'`。
 */
export function quotaLevel(
    remaining?: number | null,
    limit?: number | null,
): QuotaLevel | null {
    if (!isNum(remaining) || !isNum(limit)) return null
    if (limit <= 0) return 'unlimited'
    if (remaining <= 0) return 'empty'
    const ratio = remaining / limit
    if (ratio < QUOTA_LOW_RATIO) return 'critical'
    if (ratio < QUOTA_OK_RATIO) return 'low'
    return 'ok'
}

/**
 * 余额条宽度（百分比，四舍五入后钳到 0..100）。不限档返回 0——调用方**不该画这条**：
 * `limit` 是 0，画出来是一条"0% 的空条"，看着像额度用光了。
 *
 * 与文案是两条通道：条宽四舍五入后可能与文字对不上（剩 1/500 显示 0%），
 * 所以**别拿条宽当判据**，读屏与测试都认那几个字。
 */
export function quotaPct(
    remaining?: number | null,
    limit?: number | null,
): number {
    if (!isNum(remaining) || !isNum(limit) || limit <= 0) return 0
    const pct = Math.round((remaining / limit) * 100)
    return Math.min(100, Math.max(0, pct))
}

/**
 * 主角那个数：**剩多少**。三种形态各说各的话（见文件头注）——
 * 「不限额」/「额度 —」/「剩 363 / 500」。
 *
 * `remaining` 钳到 `0..limit`：`chat_quota_used` 允许**超过**上限（把 `CHAT_QUOTA_LIMIT`
 * 调小之后，存量账号的已用数就比新的上限还大），而「剩 -3 / 500」不是人话、也不是
 * 事实（他真的用不到负数那么多）。钳制只在这里做——四处显示都从这儿取字。
 */
export function quotaBalanceText(
    remaining?: number | null,
    limit?: number | null,
): string {
    const level = quotaLevel(remaining, limit)
    if (level === null) return '额度 —'
    if (level === 'unlimited') return '不限额'
    const rest = Math.min(Number(limit), Math.max(0, Number(remaining)))
    return `剩 ${rest} / ${limit}`
}

/** 次角那句：已用多少轮。读不到或读不出数时返回空串（调用方直接不渲染）。 */
export function quotaUsedHint(
    used?: number | null,
    limit?: number | null,
): string {
    if (!isNum(used) || !isNum(limit) || limit <= 0) return ''
    return `已用 ${used} 轮`
}

/**
 * 后台账号行上那枚 chip 的一整句（含「额度：」前缀）。与 `quotaBalanceText` 分开，
 * 是因为账号行与额度页签的排版不同（一个是一行 chip、一个是 20px 大数 + 副提示），
 * 但**数字口径必须同源**——所以它只是前缀 + 上面那个函数。
 */
export function quotaChipText(
    used?: number | null,
    limit?: number | null,
): string {
    if (!isNum(used) || !isNum(limit)) return '额度 —'
    if (limit <= 0) return '额度：不限额'
    return `额度：${quotaBalanceText(limit - used, limit)}`
}
