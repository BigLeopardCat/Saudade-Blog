import type {MouseEvent} from "react";

export const resetDescScroll = (e: MouseEvent<HTMLElement>) => {
    const el = e.currentTarget
    // 只在真的滚过时赋值：`scrollTop = 0` 本身不会触发滚动事件，
    // 但省掉这次写入可以让绝大多数"没滚过"的移出完全无副作用。
    if (el.scrollTop !== 0) el.scrollTop = 0
}
