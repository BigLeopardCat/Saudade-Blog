import { parseNoteTags } from '../../../../utils/noteTags';
import type {AdminNoteQuery} from '../../../../apis/adminNotesApi';

export type ListTab = '1' | '2' | '3' | '4';

export interface ListQuery {
    tab: ListTab;
    page: number;
    size: number;
    kw: string;
    title: string;
    cat: string;
    top: string;
    from: string;
    to: string;
    tags: number[];
}

export const LIST_PAGE_SIZE = 10;

export const PAGE_SIZE_OPTIONS = [10, 20, 50];

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

export function mergeListQuery(base: ListQuery, patch: Partial<ListQuery>): ListQuery {
    return { ...base, ...patch };
}

export function listRequest(query: ListQuery): AdminNoteQuery {
    const states: Record<ListTab, AdminNoteQuery['status']> = {'1': undefined, '2': 'private', '3': 'draft', '4': 'public'};
    return {
        page: query.page,
        page_size: query.size,
        ...(query.kw ? { keyword: query.kw } : {}),
        ...(query.title ? { title: query.title } : {}),
        ...(query.cat ? { categories: query.cat } : {}),
        ...(query.top !== '' ? { is_top: Number(query.top) } : {}),
        ...(query.from ? { start_date: query.from } : {}),
        ...(query.to ? { end_date: query.to } : {}),
        ...(query.tags.length ? { tags: query.tags.join(',') } : {}),
        ...(states[query.tab] ? {status: states[query.tab]!} : {}),
    };
}

export function saveListReturn(search: string): void {
    try {
        window.sessionStorage.setItem(LIST_RETURN_KEY, search);
    } catch {
    }
}

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
