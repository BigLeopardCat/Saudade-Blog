import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { CategoriesType } from '../../interface/CategoriesType';
import { catalogApi } from '../catalogApi';

interface categoryList {
    categories: CategoriesType[];
    categoryCount: number;
}
const initialState: categoryList = { categories: [], categoryCount: 0 };
const categoriesSlice = createSlice({
    name: 'categories',
    initialState,
    reducers: {
        setCategories(state, action: PayloadAction<CategoriesType[]>) {
            state.categories = action.payload;
            state.categoryCount = action.payload.length;
        },
    },
    extraReducers: builder => builder.addMatcher(catalogApi.endpoints.categories.matchFulfilled, (state, { payload }) => {
        state.categories = payload;
        state.categoryCount = payload.length;
    }),
});

// Compatibility entry for existing public-site consumers; all reads now share
// the same RTK Query request. Failed refreshes never replace the last good data.
const fetchCategories = (forceRefetch = false) => catalogApi.endpoints.categories.initiate(undefined, { subscribe: false, forceRefetch });
const { setCategories } = categoriesSlice.actions;
export { setCategories, fetchCategories };
export type { categoryList };
export default categoriesSlice.reducer;
