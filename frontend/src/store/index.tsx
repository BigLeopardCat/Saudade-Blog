import {configureStore} from "@reduxjs/toolkit";
import userReducer from "./components/user.tsx";
import talksReducer from "./components/talks.tsx";
import categoriesReducer from "./components/categories.tsx";
import tagReducer from "./components/tags.tsx";
import NoteReducer from "./components/note.tsx";
import { setupListeners } from '@reduxjs/toolkit/query';
import { AGENT_TURN_DONE_EVENT } from '../components/UserCenter/agentTurn';
import { catalogApi } from './catalogApi';
import {galleryApi} from '../apis/galleryApi';

const store = configureStore({
    reducer: {
        user: userReducer,
        talks: talksReducer,
        categories: categoriesReducer,
        tags: tagReducer,
        notes: NoteReducer,
        [catalogApi.reducerPath]: catalogApi.reducer,
        [galleryApi.reducerPath]: galleryApi.reducer,
    },
    middleware: getDefaultMiddleware => getDefaultMiddleware().concat(catalogApi.middleware, galleryApi.middleware),
})

setupListeners(store.dispatch);
window.addEventListener(AGENT_TURN_DONE_EVENT, () => {
    store.dispatch(catalogApi.util.invalidateTags(['Search']));
    store.dispatch(galleryApi.util.invalidateTags(['Images','Folders']));
});

window.addEventListener('auth-change', () => store.dispatch(galleryApi.util.resetApiState()));
window.addEventListener('storage', event => {
    if (event.key === 'tokenKey') store.dispatch(galleryApi.util.resetApiState());
});

export type AppDispatch=typeof store.dispatch;
export type RootState=ReturnType<typeof store.getState>;
export default store
