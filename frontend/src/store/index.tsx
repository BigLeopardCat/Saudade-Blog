import {configureStore} from "@reduxjs/toolkit";
import userReducer from "./components/user.tsx";
import talksReducer from "./components/talks.tsx";
import categoriesReducer from "./components/categories.tsx";
import tagReducer from "./components/tags.tsx";
import NoteReducer from "./components/note.tsx";
import { setupListeners } from '@reduxjs/toolkit/query';
import { catalogApi } from './catalogApi';

const store = configureStore({
    reducer: {
        user: userReducer,
        talks: talksReducer,
        categories: categoriesReducer,
        tags: tagReducer,
        notes: NoteReducer,
        [catalogApi.reducerPath]: catalogApi.reducer,
    },
    middleware: getDefaultMiddleware => getDefaultMiddleware().concat(catalogApi.middleware),
})

setupListeners(store.dispatch);

export default store
