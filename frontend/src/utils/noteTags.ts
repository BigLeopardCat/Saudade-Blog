// ══════════════════════════════════════════════════════════════════════════
// note.tags 的编解码
//
// 存储形态是**逗号分隔的标签 id 字符串**（`src/entity/note.rs`），既不是数组也没有
// 外键；后端 `update_note` 对 `noteTags` 是 `if let Some(v) { Set(Some(v)) }` —— 也就是说
// **传空串会真的把标签清空**。所以「读」必须容忍一切脏值、"写"必须走同一个出口。
//
// 这个文件存在的理由：`split(',').map(parseInt)` 曾在前端 10 个地方各写了一遍
// （AllNotes / store-note / articleRecord / ContentHome ×3 …），每一遍都少了三件事：
// 丢空片、丢掉解析不出来的片、去重。脏数据（`"1,1,,"`、`"1,2,3,"` 这类历史尾巴）在
// 列表上会渲染成重复标签或空白标签块。
// ══════════════════════════════════════════════════════════════════════════

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

/**
 * 写：id 数组 → 后端要的字符串。空数组返回 `''`（后端会把它当成"清空标签"，这是调用方
 * 的明确意图；**不要**为了"看起来安全"就跳过不传 —— 那样用户永远清不掉标签）。
 */
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
