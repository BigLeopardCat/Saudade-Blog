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
import {privateApi, FAVORITES_CHANGED_EVENT, UNREAD_CHANGED_EVENT} from '../apis/privateApi';

const store = configureStore({
    reducer: {
        user: userReducer,
        talks: talksReducer,
        categories: categoriesReducer,
        tags: tagReducer,
        notes: NoteReducer,
        [catalogApi.reducerPath]: catalogApi.reducer,
        [galleryApi.reducerPath]: galleryApi.reducer,
        [privateApi.reducerPath]: privateApi.reducer,
    },
    middleware: getDefaultMiddleware => getDefaultMiddleware().concat(catalogApi.middleware, galleryApi.middleware, privateApi.middleware),
})

setupListeners(store.dispatch);
window.addEventListener(AGENT_TURN_DONE_EVENT, () => {
    store.dispatch(catalogApi.util.invalidateTags(['Search']));
    store.dispatch(galleryApi.util.invalidateTags(['Images','Folders']));
    store.dispatch(privateApi.util.invalidateTags(['Favorites','FavoriteState','Unread']));
});

window.addEventListener(FAVORITES_CHANGED_EVENT, () => {
    store.dispatch(privateApi.util.invalidateTags(['Favorites','FavoriteState']));
});
window.addEventListener(UNREAD_CHANGED_EVENT, () => store.dispatch(privateApi.util.invalidateTags(['Unread'])));

function resetPrivateQueries() {
    for (const query of store.dispatch(privateApi.util.getRunningQueriesThunk())) query.abort();
    for (const query of store.dispatch(galleryApi.util.getRunningQueriesThunk())) query.abort();
    store.dispatch(privateApi.util.resetApiState());
    store.dispatch(galleryApi.util.resetApiState());
}
window.addEventListener('auth-change', resetPrivateQueries);
window.addEventListener('storage', event => {
    if (event.key === 'tokenKey' || event.key === null) resetPrivateQueries();
});

export type AppDispatch=typeof store.dispatch;
export type RootState=ReturnType<typeof store.getState>;
export default store
