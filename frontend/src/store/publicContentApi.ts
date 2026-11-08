import http from '../apis/axios';
import { catalogApi } from './catalogApi';

export interface ArchiveItem {
    noteKey: number;
    noteTitle: string;
    createTime: string;
}

export interface PublicTalk {
    talkKey: number;
    talkTitle: string;
    content: string;
    nickname: string;
    avatar: string | null;
    createTime: string;
    updateTime: string;
}

interface FeedPage<T> {
    items: T[];
    nextCursor: string | null;
    total?: number;
}

async function readPage<T>(path: string, limit: number, cursor: string | null,
                           signal: AbortSignal, requireTotal = false): Promise<FeedPage<T>> {
    const response = await http({ url: path, method: 'GET', params: { limit, cursor }, signal });
    const page = response.data?.data;
    if (response.status !== 200 || response.data?.code !== 200 || !page ||
        !Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string') ||
        (requireTotal && (!Number.isSafeInteger(page.total) || page.total < 0))) {
        throw new Error('公开内容暂时无法读取');
    }
    return page;
}

export const publicContentApi = catalogApi.injectEndpoints({
    endpoints: build => ({
        archiveFeed: build.infiniteQuery<FeedPage<ArchiveItem>, void, string | null>({
            infiniteQueryOptions: {
                initialPageParam: null,
                getNextPageParam: page => page.nextCursor ?? undefined,
            },
            async queryFn({ pageParam }, { signal }) {
                try {
                    return { data: await readPage<ArchiveItem>('/api/public/archive', 50, pageParam, signal, true) };
                } catch {
                    return { error: { message: '归档加载失败，请重试' } };
                }
            },
        }),
        talkFeed: build.infiniteQuery<FeedPage<PublicTalk>, void, string | null>({
            infiniteQueryOptions: {
                initialPageParam: null,
                getNextPageParam: page => page.nextCursor ?? undefined,
            },
            async queryFn({ pageParam }, { signal }) {
                try {
                    return { data: await readPage<PublicTalk>('/api/public/talk/feed', 20, pageParam, signal) };
                } catch {
                    return { error: { message: '说说加载失败，请重试' } };
                }
            },
        }),
        publicTalk: build.query<PublicTalk, number>({
            async queryFn(id, { signal }) {
                try {
                    const response = await http({ url: `/api/public/talk/${id}`, method: 'GET', signal });
                    if (response.status !== 200 || response.data?.code !== 200 ||
                        response.data.data?.talkKey !== id) {
                        return { error: { message: '这条说说不存在或暂时无法读取' } };
                    }
                    return { data: response.data.data };
                } catch {
                    return { error: { message: '这条说说不存在或暂时无法读取' } };
                }
            },
        }),
    }),
});

export const { useArchiveFeedInfiniteQuery, useTalkFeedInfiniteQuery, usePublicTalkQuery } = publicContentApi;
