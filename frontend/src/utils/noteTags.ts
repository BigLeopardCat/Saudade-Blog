// 编辑器的 noteTags 协议使用逗号分隔的 id；空串表示清空，省略字段表示保持。
// 数据库标签关系以 note_tag 为准，此处只负责前端输入的编解码。

/** 只保留**正整数**（标签 id 都是自增正整数）：`'12abc'`/`'0'`/`'-3'`/`''`/`'NaN'` 全部丢掉 */
function toTagId(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value > 0 ? value : null;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        // 用 Number 而不是 parseInt：parseInt('12abc') = 12 会把脏值悄悄当成合法 id
        const n = Number(trimmed);
        return trimmed !== '' && Number.isInteger(n) && n > 0 ? n : null;
    }
    return null;
}

/**
 * 读：把后端给的 `noteTags` 规整成去重后的 id 数组。
 * 容忍 `"1,2"` / `""` / `"1,1,,"` / `[1,2]` / `null` / undefined / 数字数组混字符串。
 */
export function parseNoteTags(raw: unknown): number[] {
    if (raw === null || raw === undefined) return [];
    const parts = Array.isArray(raw) ? raw : String(raw).split(',');
    const out: number[] = [];
    for (const part of parts) {
        const id = toTagId(part);
        if (id !== null && !out.includes(id)) out.push(id);
    }
    return out;
}

/** 编码标签 id；空数组发送空串，明确请求清空标签。 */
export function joinNoteTags(ids: Array<number | string> | null | undefined): string {
    if (!ids || ids.length === 0) return '';
    const out: number[] = [];
    for (const raw of ids) {
        const id = toTagId(raw);
        if (id !== null && !out.includes(id)) out.push(id);
    }
    return out.join(',');
}

/** 排序后比较两个 id 集合是否相同（用于判断"标签有没有被改过"，顺序不同不算改） */
export function sameTagSet(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    const sa = [...a].sort((x, y) => x - y);
    const sb = [...b].sort((x, y) => x - y);
    return sa.every((v, i) => v === sb[i]);
}
