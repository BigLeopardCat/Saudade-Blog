import { configureStore } from '@reduxjs/toolkit';
import { afterEach } from 'vitest';
import categories from '../../src/store/components/categories';
import tags from '../../src/store/components/tags';
import { catalogApi } from '../../src/store/catalogApi';

const stores = new Set<ReturnType<typeof makeStore>>();
const makeStore = () => configureStore({
    reducer: { categories, tags, [catalogApi.reducerPath]: catalogApi.reducer },
    middleware: getDefaultMiddleware => getDefaultMiddleware().concat(catalogApi.middleware),
});
export function createCatalogStore() {
    const store = makeStore();
    stores.add(store);
    return store;
}
afterEach(() => {
    for (const store of stores) store.dispatch(catalogApi.util.resetApiState());
    stores.clear();
});
