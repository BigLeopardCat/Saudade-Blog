import http from './axios';
import { catalogApi } from '../store/catalogApi';
import type { AggregateResult, SearchType } from '../frontHome/Head/aggregate';
export type SearchQuery = { keyword: string; page?: number; pageSize?: number; type?: SearchType };

/** Aggregate-only endpoint; article and Agent search keep their contract. */
function searchAll(data: SearchQuery, signal?: AbortSignal) {
    return http<{ code: number; message: string; data: AggregateResult }>({
        url: '/api/public/search', method: 'POST', data, signal,
    });
}
const searchApi = catalogApi.injectEndpoints({
    endpoints: build => ({
        aggregateSearch: build.query<AggregateResult, SearchQuery>({
            async queryFn(query, { signal }) {
                try {
                    const response = await searchAll(query, signal);
                    const data = response.data?.data;
                    if (response.status !== 200 || response.data?.code !== 200 || !data ||
                        ![data.notes, data.talks, data.board, data.comments].every(Array.isArray) || !Number.isFinite(data.total)) {
                        return { error: { message: response.data?.message || '搜索失败，请稍后重试' } };
                    }
                    return { data };
                } catch (error) {
                    const message = (error as { response?: { data?: { message?: string } } }).response?.data?.message;
                    return { error: { message: message || '搜索失败，请稍后重试' } };
                }
            },
            keepUnusedDataFor: 0,
        }),
    }),
});
export const { useLazyAggregateSearchQuery } = searchApi;
export { searchAll };
export type { AggregateResult };
