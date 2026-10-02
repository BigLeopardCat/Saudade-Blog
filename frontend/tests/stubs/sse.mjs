/**
 * SSE 响应的**响应头**桩（20261002）。
 *
 * **为什么要有这个东西**：`chat-stream.js` 自 20261002 起多了一道内容类型守卫——
 * 响应的 `content-type` 不是 `text/event-stream` 就如实报错，而不是拿着一个切不出
 * 任何帧的 body 一路走到"空回复"静默收场（事故形状见 `tests/chat-non-sse-fallback.test.mjs`
 * 头注：agent 不可用时服务端回 `200 + application/json`，前端零提示）。
 *
 * 代价是：**harness 里手搓的 SSE 桩如果只有 `{ ok: true, body: {...} }`，会当场被判成
 * "不是流"**。20261002 实测——`chat-boot-smoke` / `chat-stopped-turn` / `chat-time-divider`
 * 三支一起红，而它们红的位置离真因很远（看起来像"对话流程坏了"）。真响应一定有这个头
 * （axum 与 nginx 都会带），所以补齐桩才是**如实**，不是为了让判据好看。
 *
 * 用法：把 `...sseHeaders()` 摊进桩对象里。
 *   return { ok: true, ...sseHeaders(), body: { getReader: () => ({...}) } };
 */
export const sseHeaders = () => ({
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
});
