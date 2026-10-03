/**
 * 中文钟面时间的**展示**格式化（全仓唯一一份）。
 *
 * 后端给的时间串**已经是 +08:00 中国钟面**（DB 会话 `time_zone=+08:00`，见 CLAUDE.md
 * 的《时区约定》），所以这里只做裁剪、**不做任何时区换算**。
 *
 * 刻意用字符串正则而不是 `Date`：只要不构造 Date，就不可能出现"浏览器时区/UTC 解释"
 * 这类二次偏移。20260922 那次事故正是旧实现把 `s` 当 UTC（拼 'Z'）再 +8h —— 那是
 * 20260827 统一时区**之前**的口径，时区统一之后线上所有公告时间整整多了 8 小时。
 *
 * 20261004 从 `components/AnnouncementModal/index.tsx` 抽出来（首页公告栏也要显示时间）。
 * 抽的理由是老规矩：同一件事两份实现必然分叉 —— 那边是弹窗里的 `YYYY-MM-DD HH:mm`，
 * 这边列表里只要 `MM-DD`。
 */

/** 时间串缺省形态：`2026-10-04 21:07:33` 或 `2026-10-04T21:07:33`（后端两种都给过） */
const CN_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/

/**
 * @param s 后端给的钟面时间串（空串 → 空串；认不出来 → **原样返回**，不猜、不编）
 * @param opts.withTime 是否带时分（默认 true）。`false` 只给 `MM-DD`，用于列表那种一行一条的窄位。
 */
export function fmtCnTime(s: string, opts?: { withTime?: boolean }): string {
    if (!s) return ''
    const m = CN_TIME_RE.exec(s)
    if (!m) return s
    const [, y, mo, d, h, mi] = m
    return (opts?.withTime ?? true) ? `${y}-${mo}-${d} ${h}:${mi}` : `${mo}-${d}`
}
