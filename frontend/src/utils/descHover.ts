import type {MouseEvent} from "react";

/**
 * 悬浮展开的简介：**鼠标离开时必须自己把滚位抹回顶部**（20260930）。
 *
 * 为什么非抹不可：简介的静置态是 `overflow: hidden` + 行数钳制，展开态是
 * `overflow-y: auto` + 定高——而 **`overflow: hidden` 的盒子同样是滚动容器**
 * （实测静置态下 `scrollHeight` 就是全文高度、`clientHeight` 只有 3 行）。
 * 于是"悬浮展开 → 往下滚 → 鼠标离开"之后，滚位**留在那里**：静置态那三行显示的是
 * 全文的中段，而不是开头（用户报的"简介没有回到头部"）。纯 CSS 里没有"回到顶部"
 * 这件事，`-webkit-line-clamp` 也不会把滚位归零，只有在这里抹。
 *
 * 两个调用点（普通卡 `Article.tsx`、置顶卡 `ContentHome/index.tsx`）共用这一份实现：
 * 判据只有一处，免得两边各写一个"大概是这样"。
 */
export const resetDescScroll = (e: MouseEvent<HTMLElement>) => {
    const el = e.currentTarget
    // 只在真的滚过时赋值：`scrollTop = 0` 本身不会触发滚动事件，
    // 但省掉这次写入可以让绝大多数"没滚过"的移出完全无副作用。
    if (el.scrollTop !== 0) el.scrollTop = 0
}
