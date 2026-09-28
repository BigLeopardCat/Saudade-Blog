/**
 * 对话额度的**展示口径**（20260929 第二批）：一律按**余额**说，不按"已用"说。
 *
 * ── 为什么要有这一个文件 ────────────────────────────────────────────────
 * 同一个数要在**四处**露面：个人中心「对话额度」页签、后台账号管理行上那枚 chip、
 * 后台额度管理那一列、以及 agent 系统上下文里那一行。四处都要「余额 = 上限 − 已用」
 * 这同一条减法，还要共用同一套变色阈值。抄四份就是四个漂移源——本仓"手抄第二份名单"
 * 反复出过事（`_ARG_TYPE_SHORT` 与 `iter_trace_files` 两处注记了同一条教训）。
 *
 * ── 存储与展示是两个口径，**刻意不统一** ────────────────────────────────
 * 库里存的是**累计已用** `chat_quota_used`：`UPDATE … SET used = used + 1
 * WHERE used < limit` 这一条语句是并发不变量（`rows_affected == 1` ⇒ 这一轮抢到了）
 * 的载体——换成余额递减要让那条语句变成读-改-写，窗口就回来了。所以**存累计、
 * 显示余额**，两边各自都对；谁想"统一"它，先读 `src/quota.rs` 那段注。
 *
 * ── 阈值（用户拍板的是"余额条会变色"这件事，具体档位定在这里）────────────
 *   ≥ 50%   充足 —— 品牌金（与站内 `.ucGoldBtn` 同族）
 *   20–50%  偏低 —— 琥珀
 *   < 20%   告急 —— 朱红（与 `.rz-no` / `.ucReject` 同一族色，夜间各亮一档）
 *   = 0     用尽 —— 朱红、条为空
 * 档位只有一个来源：改这里，四处一起改（`.test.mjs` 锁住这一点）。
 *
 * ── 三种"不是数字"的形态必须分开，不许合并 ──────────────────────────────
 *   · `limit === 0` ⇒ **不限额**（后端 `quota::limit_of` 的口径：0 是"不限"，
 *     与"上限为零/用完了"正好相反）；
 *   · 字段缺失（前端已上线、后端还没到）⇒ **「额度 —」**，不是 `剩 0/0`
 *     ——后者会被读成"这个人用完了"，而同一行上没有别的线索能纠正它；
 *   · `remaining` 为 0 且 `limit > 0` ⇒ 真的**用尽**。
 */

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
