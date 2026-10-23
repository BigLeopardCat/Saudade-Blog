import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import type { CategoriesType } from '../interface/CategoriesType';
import type { TagLevelOne } from '../interface/TagType';
import { getCategories } from '../apis/CategoryMethods';
import { loadTags } from '../apis/catalogReads';

type CatalogError = { message: string };

// This API contains public reads, including injected aggregate search; no account-specific data.
// RTK Query owns request deduplication, cache lifetime and polling. Existing
// Redux selectors temporarily consume read models updated on fulfilled actions.
export const catalogApi = createApi({
    reducerPath: 'catalogApi',
    baseQuery: fakeBaseQuery<CatalogError>(),
    tagTypes: ['Categories', 'Tags'],
    keepUnusedDataFor: 60,
    invalidationBehavior: 'delayed',
    endpoints: build => ({
        categories: build.query<CategoriesType[], void>({
            async queryFn(_arg, { signal }) {
                try {
                    const response = await getCategories(signal);
                    if (response.status !== 200 || response.data?.code !== 200 || !Array.isArray(response.data.data)) {
                        return { error: { message: '分类加载失败，请刷新重试' } };
                    }
                    return { data: response.data.data.map((row: Omit<CategoriesType, 'key'>) => ({ ...row, key: row.categoryKey })) };
                } catch {
                    return { error: { message: '分类加载失败，请刷新重试' } };
                }
            },
            providesTags: ['Categories'],
        }),
        tags: build.query<TagLevelOne[], void>({
            async queryFn(_arg, { signal }) {
                try {
                    return { data: await loadTags(signal) };
                } catch {
                    return { error: { message: '标签加载失败，请刷新重试' } };
                }
            },
            providesTags: ['Tags'],
        }),
    }),
});

export const { useCategoriesQuery, useTagsQuery } = catalogApi;
