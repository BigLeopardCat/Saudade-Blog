import {configureStore} from '@reduxjs/toolkit';
import {describe, expect, it, vi} from 'vitest';
import reducer, {fetchUserInfo} from '../../src/store/components/user';
const {http} = vi.hoisted(() => ({http: vi.fn()}));
vi.mock('../../src/apis/axios.tsx', () => ({default: http}));
describe('public metadata is independent from visitor authentication', () => {
    it.each(['network', 'business', 'malformed'])('preserves credentials and cached metadata on %s failure', async kind => {
        const store = configureStore({reducer: {user: reducer}});
        http.mockResolvedValueOnce({status: 200, data: {code: 200, data: {blogTitle: '已有站名'}}});
        expect(await store.dispatch(fetchUserInfo())).toBe(true);
        localStorage.setItem('tokenKey', 'valid-visitor-token');
        if (kind === 'network') http.mockRejectedValueOnce(new Error('offline'));
        else http.mockResolvedValueOnce({status: 200, data: kind === 'business' ? {code: 500, data: null} : {code: 200, data: null}});
        expect(await store.dispatch(fetchUserInfo())).toBe(false);
        expect(localStorage.getItem('tokenKey')).toBe('valid-visitor-token');
        expect(store.getState().user.blogTitle).toBe('已有站名');
    });
});
