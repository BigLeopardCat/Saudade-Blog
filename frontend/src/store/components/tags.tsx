import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { TagLevelOne } from '../../interface/TagType';
import { catalogApi } from '../catalogApi';

interface Tag {
    tag: TagLevelOne[];
    tagCount: number;
}
const initialState: Tag = { tag: [], tagCount: 0 };
const tagSlice = createSlice({
    name: 'tags',
    initialState,
    reducers: {
        setTags(state, action: PayloadAction<TagLevelOne[]>) {
            state.tag = action.payload;
            state.tagCount = action.payload.reduce((count, row) => count + 1 + row.children.length, 0);
        },
    },
    extraReducers: builder => builder.addMatcher(catalogApi.endpoints.tags.matchFulfilled, (state, { payload }) => {
        state.tag = payload;
        state.tagCount = payload.reduce((count, row) => count + 1 + row.children.length, 0);
    }),
});
const fetchTags = (forceRefetch = false) => catalogApi.endpoints.tags.initiate(undefined, { subscribe: false, forceRefetch });
const { setTags } = tagSlice.actions;
export { setTags, fetchTags };
export default tagSlice.reducer;
