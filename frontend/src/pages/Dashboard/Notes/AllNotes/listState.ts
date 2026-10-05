// ══════════════════════════════════════════════════════════════════════════
// 后台文章列表的状态：**URL query 是唯一真源**
//
// 用户诉求原文：「翻到一页改完文章配置，页码又回到第一页了」。根因有两条，都要堵：
//   ① 组件挂载时机 —— 编辑器 `navigate('/dashboard/notes')` 会把列表整棵重挂，
//      分页组件的 useState 回到初始值（这条靠"从编辑器回列表时带上票据"解决，见
//      `readListReturn`）；
//   ② antd 分页的内部钳制 —— 任何一次整表重拉只要让 total 变小（例如改完配置后
//      过滤掉了不匹配当前 tab 的行），当前页就可能 > 最大页而被弹回第 1 页。
//      对策是**渲染期派生钳制**（`clampPage`），绝不把钳制结果写回 URL。
//
// 三条铁律（违反任何一条都会踩成无限请求/无限重渲染）：
//   1. 取数 effect **只读** URL，绝不回写 URL（"发现越界就 setSearchParams"= 死循环）；
//   2. effect 的 deps 只放**原始字符串**（tab/kw/title/cat/top/from/to），
//      绝不能放 `searchParams` 对象 —— `useSearchParams` 每次 set 都产生新实例，
//      对象做 deps 会无限重渲染 + 无限请求；
//   3. 空值在 URL 里必须**删除**而不是 `set('')`（否则 URL 噪声、deps 误判为变化）。
//
// 这个文件单独存在（而不是写在组件里）是为了能在本机不 build 的前提下直接单测：
// `frontend/tests/notes-list-state.test.mjs` 用 esbuild 把它打进临时目录再由 node 断言。
// ══════════════════════════════════════════════════════════════════════════

import { parseNoteTags } from '../../../../utils/noteTags';
import type { NoteType } from '../../../../interface/NoteType';

/**
 * 页签编号。'4' = **公开文章**（20261006 用户第 5 条新加），它在页签条上排在**最前面**，
 * 但编号刻意取 4 —— 编号是 URL 里的既有契约（`?tab=2/3` 的深链、默认 `'1'`、
 * 「默认值不落 URL」的 `buildListQuery` 全都按 '1' 写死），拿它当数组下标用会把这些一起搅动。
 */
export type ListTab = '1' | '2' | '3' | '4';

export interface ListQuery {
    /** '1' 全部文章 / '2' 私密文章 / '3' 草稿箱 / '4' 公开文章 */
    tab: ListTab;
    /** 页码，从 1 开始 */
    page: number;
    /** 每页条数（20260924 起可调，见 `PAGE_SIZE_OPTIONS`） */
    size: number;
    /** 关键词（命中标题/正文/标签名），对应后端 `keyword` */
    kw: string;
    /** 仅标题筛选，对应后端 `title` */
    title: string;
    /** 分类名，对应后端 `categories` */
    cat: string;
    /** 置顶筛选：'' | '1' | '0' */
    top: string;
    /** 起止日期（YYYY-MM-DD），对应后端 start_date/end_date */
    from: string;
    to: string;
    /** 标签筛选（**前端过滤**，不进 URL 请求体） */
    tags: number[];
}

/**
 * 默认每页条数（20260924：8 → 10）。
 * 原来是 8，而列表区被 `scroll={{y:'56vh'}}` 固定在 504px 高（900 高的窗口）——
 * 一行 73px，**第 8 行恰好被藏进滚动区**，屏幕下方却空着 150px。现在列表区铺满卡片、
 * 分页条钉在卡片底部，条数改由用户自己选（见 `PAGE_SIZE_OPTIONS`）。
 */
export const LIST_PAGE_SIZE = 10;

/** 每页条数的可选项（URL 里 `size=` 只认这几个值，别的一律回落到默认） */
export const PAGE_SIZE_OPTIONS = [10, 20, 50];

/** 从编辑器返回列表时放的"返回票据"（sessionStorage），键名全局唯一 */
export const LIST_RETURN_KEY = 'notes:listReturn';

export const DEFAULT_LIST_QUERY: ListQuery = {
    tab: '1',
    page: 1,
    size: LIST_PAGE_SIZE,
    kw: '',
    title: '',
    cat: '',
    top: '',
    from: '',
    to: '',
    tags: [],
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/**
 * 读 URL。容忍缺参、脏值、以及历史深链：
 * - `keyword` 是 `kw` 的**旧别名**（`Dashboard/index.tsx` 的搜索框曾直接跳 `?keyword=`），
 *   两者同时存在时以 `kw` 为准 —— 已存在的 bookmark 不能失效；
 * - `page` 非正整数 → 1；`tab` 非 1/2/3/4 → '1'；日期不合法 → 丢弃。
 */
export function parseListQuery(search: string | URLSearchParams): ListQuery {
    const params =
        typeof search === 'string'
            ? new URLSearchParams(search.replace(/^\?/, ''))
            : search;

    const rawTab = params.get('tab');
    const tab: ListTab =
        rawTab === '2' || rawTab === '3' || rawTab === '4' ? rawTab : '1';

    const rawPage = Number(params.get('page'));
    const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

    // 每页条数只认白名单：它要直接喂给 slice/clampPage，放任何数字进来都可能让列表
    // 一页都装不满（size=0 已被 clampPage 兜住，但没有理由让它走到那里）
    const rawSize = Number(params.get('size'));
    const size = PAGE_SIZE_OPTIONS.includes(rawSize) ? rawSize : LIST_PAGE_SIZE;

    const kw = params.get('kw') ?? params.get('keyword') ?? '';
    const rawTop = params.get('top');
    const from = params.get('from') ?? '';
    const to = params.get('to') ?? '';

    return {
        tab,
        page,
        size,
        kw,
        title: asString(params.get('title')),
        cat: asString(params.get('cat')),
        top: rawTop === '1' || rawTop === '0' ? rawTop : '',
        from: DATE_RE.test(from) ? from : '',
        to: DATE_RE.test(to) ? to : '',
        tags: parseNoteTags(params.get('tags')),
    };
}

/**
 * 写 URL：**默认值不落 URL**（tab=1 / page=1 / 各项为空），返回不带 `?` 的 query 串，
 * 可直接喂 `setSearchParams(...)`。空值走 `delete` 而不是 `set('')` —— 见文件头铁律 3。
 */
export function buildListQuery(query: ListQuery): string {
    const params = new URLSearchParams();
    if (query.tab !== '1') params.set('tab', query.tab);
    if (query.page > 1) params.set('page', String(query.page));
    if (query.size !== LIST_PAGE_SIZE) params.set('size', String(query.size));
    if (query.kw) params.set('kw', query.kw);
    if (query.title) params.set('title', query.title);
    if (query.cat) params.set('cat', query.cat);
    if (query.top) params.set('top', query.top);
    if (query.from) params.set('from', query.from);
    if (query.to) params.set('to', query.to);
    if (query.tags.length > 0) params.set('tags', query.tags.join(','));
    return params.toString();
}

/** 合并补丁（`setParam` 的纯逻辑部分）：`page` 由调用方显式给，不在这里猜"要不要回第一页" */
export function mergeListQuery(base: ListQuery, patch: Partial<ListQuery>): ListQuery {
    return { ...base, ...patch };
}

/**
 * 渲染期钳制：当前页超出最大页时**只用于显示/切片**，不写回 URL。
 * `total=0` 时回 1（而不是 0）—— antd 分页的 current 不接受 0。
 */
export function clampPage(page: number, total: number, pageSize: number = LIST_PAGE_SIZE): number {
    const size = pageSize > 0 ? pageSize : LIST_PAGE_SIZE;
    const maxPage = Math.max(1, Math.ceil(total / size));
    const want = Number.isInteger(page) && page > 0 ? page : 1;
    return Math.min(Math.max(1, want), maxPage);
}

/** 本地分页切片（与 clampPage 用同一个钳制结果，保证"显示第几页"和"切出哪几行"永不脱节） */
export function pageSlice<T>(rows: T[], page: number, pageSize: number = LIST_PAGE_SIZE): T[] {
    const current = clampPage(page, rows.length, pageSize);
    const start = (current - 1) * pageSize;
    return rows.slice(start, start + pageSize);
}

/** 后端返回的原始行 → 组件内部行（收敛掉此前散落 5 份的 map + split 复制粘贴） */
export function normalizeNoteRows(raw: unknown): NoteType[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((item: any) => ({
        ...item,
        key: item?.noteKey,
        noteTags: parseNoteTags(item?.noteTags),
    })) as NoteType[];
}

/** 就地打补丁：只换目标行，其余行保持**同一对象引用**（减少无谓重渲染） */
export function patchRow<T extends { key?: unknown }>(
    rows: T[],
    key: unknown,
    patch: Partial<T>,
): T[] {
    let changed = false;
    const next = rows.map((row) => {
        if (row.key !== key) return row;
        changed = true;
        return { ...row, ...patch };
    });
    return changed ? next : rows;
}

/** 标签筛选（选中任一即命中）；空选择 = 不过滤 */
export function filterRowsByTags(rows: NoteType[], tagIds: number[]): NoteType[] {
    if (tagIds.length === 0) return rows;
    return rows.filter((row) => {
        const own = Array.isArray(row.noteTags) ? row.noteTags : [];
        return tagIds.some((id) => own.includes(id));
    });
}

export type ListRequest =
    | { mode: 'list' }
    | { mode: 'search'; body: Record<string, unknown> };

/**
 * 该发哪个请求：
 * - 「全部文章」且**零条件** → `/notes/list`（它排除 `draft_of` 影子行，与搜索端点语义不同，
 *   不能合并成一个）；
 * - 其余 → `/notes/search`，把 URL 里的条件翻译成后端字段。**「公开文章」页签（'4'）永远
 *   走这一支**：它编号就不是 '1'，而且它本体自带 `only_public` 条件（零筛选也非空请求）。
 *
 * 注意 `tags` 是前端过滤，**不进 body**（后端 `SearchRequest` 没有这个字段，
 * 而且它过去是"填了也白填"的静默空操作）。
 */
export function listRequest(query: ListQuery): ListRequest {
    const hasFilter =
        query.kw !== '' ||
        query.title !== '' ||
        query.cat !== '' ||
        query.top !== '' ||
        query.from !== '' ||
        query.to !== '';

    if (query.tab === '1' && !hasFilter) return { mode: 'list' };

    const body: Record<string, unknown> = {};
    if (query.kw) body.keyword = query.kw;
    if (query.title) body.title = query.title;
    if (query.cat) body.categories = query.cat;
    if (query.top !== '') body.is_top = Number(query.top);
    if (query.from) body.start_date = query.from;
    if (query.to) body.end_date = query.to;
    if (query.tab === '2') body.status = 'private';
    if (query.tab === '3') body.status = 'draft';
    // 「公开文章」页签（20261006）：口径由**后端**给（`is_public=true` 且 `status != 'draft'`
    // 且非影子行），前端不自己算 —— 站上真正能读到的那套判据有 6 处同源，前端再抄一份
    // 就会各自漂（这就是被删掉的 `utils/noteVisibility.ts` 干过的事）。
    if (query.tab === '4') body.only_public = true;

    return { mode: 'search', body };
}

/** 写"返回票据"：每次 location.search 变化都存一份，供编辑器返回时还原 */
export function saveListReturn(search: string): void {
    try {
        window.sessionStorage.setItem(LIST_RETURN_KEY, search);
    } catch {
        // 隐私模式 / 存储配额满：返回时退回"回列表首页"，不影响主流程
    }
}

/** 读"返回票据"：只接受 query 串形状（'' | '?...' | 'a=b'），别的一律当没有 */
export function readListReturn(): string | null {
    try {
        const raw = window.sessionStorage.getItem(LIST_RETURN_KEY);
        if (raw === null) return null;
        if (raw !== '' && !/^\??[A-Za-z0-9_\-%+.,=&]*$/.test(raw)) return null;
        return raw;
    } catch {
        return null;
    }
}
