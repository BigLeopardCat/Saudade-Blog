import type {ReactNode} from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {Provider} from 'react-redux';
import {MemoryRouter, useNavigate} from 'react-router-dom';
import {StyleProvider} from '@ant-design/cssinjs/lib/index.js';
import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {createCatalogStore} from '../helpers/catalogStore';
import {deferred} from '../helpers/deferred';
import {publicContentApi} from '../../src/store/publicContentApi';
import Times from '../../src/frontHome/Content/Times';
import Talks from '../../src/frontHome/Content/Talk';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../src/apis/axios', () => ({default: api}));
vi.mock('../../src/components/SeoHelmet', () => ({default: () => null}));
vi.mock('../../src/utils/scrollToTop', () => ({default: () => {}}));
const response = (data: unknown) => ({status: 200, data: {code: 200, data}});
const archive = (id: number) => ({noteKey: id, noteTitle: `文章${id}`, createTime: '2026-11-08T12:00:00'});
const talk = (id: number) => ({talkKey: id, talkTitle: `说说${id}`, content: '完整正文', nickname: '作者',
    avatar: null, createTime: '2026-11-08T12:00:00', updateTime: '2026-11-08T12:00:00'});

beforeAll(() => {
    window.matchMedia = () => ({matches: false, media: '', onchange: null, addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true});
    Element.prototype.scrollIntoView = vi.fn();
    const computed = window.getComputedStyle.bind(window);
    window.getComputedStyle = element => computed(element);
});
beforeEach(() => api.mockReset());
function mount(node: ReactNode, route = '/') {
    return render(<Provider store={createCatalogStore()}><StyleProvider mock='server'>
        <MemoryRouter initialEntries={[route]}>{node}</MemoryRouter>
    </StyleProvider></Provider>);
}

describe('RTK public cursor reads', () => {
    it('deduplicates subscriptions and More, preserves rows on failure, and retries the same cursor', async () => {
        const store = createCatalogStore();
        const next = deferred<ReturnType<typeof response>>();
        api.mockResolvedValueOnce(response({items: [archive(3), archive(2)], nextCursor: 'opaque', total: 1008}))
            .mockReturnValueOnce(next.promise)
            .mockResolvedValueOnce(response({items: [archive(1)], nextCursor: null, total: 1008}));
        const endpoint = publicContentApi.endpoints.archiveFeed;
        const first = store.dispatch(endpoint.initiate());
        const duplicate = store.dispatch(endpoint.initiate());
        await Promise.all([first, duplicate]);
        expect(api).toHaveBeenCalledTimes(1);
        const more = store.dispatch(endpoint.initiate(undefined, {direction: 'forward'}));
        const sameMore = store.dispatch(endpoint.initiate(undefined, {direction: 'forward'}));
        expect(api).toHaveBeenCalledTimes(2);
        next.reject(new Error('offline'));
        await Promise.all([more, sameMore]);
        const failed = endpoint.select()(store.getState());
        expect(failed.data?.pages[0].items).toHaveLength(2);
        expect(failed.isError).toBe(true);
        await store.dispatch(endpoint.initiate(undefined, {direction: 'forward'}));
        expect(api.mock.calls.slice(1).map(call => call[0].params.cursor)).toEqual(['opaque', 'opaque']);
        expect(endpoint.select()(store.getState()).data?.pages.flatMap(page => page.items).map(row => row.noteKey))
            .toEqual([3, 2, 1]);
        first.unsubscribe(); duplicate.unsubscribe(); more.unsubscribe(); sameMore.unsubscribe();
    });

    it('passes cancellation to HTTP and never turns an invalid total into zero', async () => {
        const store = createCatalogStore();
        const pending = deferred<ReturnType<typeof response>>();
        api.mockReturnValueOnce(pending.promise);
        const request = store.dispatch(publicContentApi.endpoints.archiveFeed.initiate());
        const signal = api.mock.calls[0][0].signal as AbortSignal;
        request.abort();
        expect(signal.aborted).toBe(true);
        await request;
        pending.resolve(response({items: [], nextCursor: null}));
        request.unsubscribe();
        api.mockResolvedValue(response({items: [], nextCursor: null}));
        const failed = await store.dispatch(publicContentApi.endpoints.archiveFeed.initiate(undefined, {forceRefetch: true}));
        expect(failed.isError).toBe(true);
        expect(failed.data).toBeUndefined();
    });
});

it('renders loading, failure and real archive total without misreporting the loaded count', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    api.mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(response({items: [archive(2)], nextCursor: 'more', total: 1008}));
    mount(<Times />);
    expect(screen.getByRole('status').textContent).toContain('正在加载归档');
    expect(screen.queryByText(/共有 0 篇/)).toBeNull();
    await act(async () => pending.reject(new Error('offline')));
    expect((await screen.findByRole('alert')).textContent).toContain('归档没能读取');
    expect(screen.queryByText(/共有 0 篇/)).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: /重\s*试/}));
    await screen.findByText('共有 1008 篇文章，再接再厉');
    expect(screen.getByText('文章2')).toBeTruthy();
});

it('loads an old talk by exact ID and changes deep links without scanning the feed', async () => {
    const older = deferred<ReturnType<typeof response>>();
    api.mockReturnValueOnce(older.promise).mockResolvedValueOnce(response(talk(72)));
    function View() {
        const navigate = useNavigate();
        return <><button onClick={() => navigate('/talk?tk=72')}>另一条</button><Talks /></>;
    }
    mount(<View />, '/talk?tk=7');
    expect(screen.getByRole('status').textContent).toContain('正在加载说说');
    expect(screen.queryByText('还没有说说')).toBeNull();
    expect(api.mock.calls[0][0].url).toBe('/api/public/talk/7');
    fireEvent.click(screen.getByRole('button', {name: '另一条'}));
    await screen.findByText('说说72');
    expect(document.getElementById('t-72')?.classList.contains('talk-hit')).toBe(true);
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    await act(async () => older.resolve(response(talk(7))));
    expect(screen.queryByText('说说7')).toBeNull();
    expect(api.mock.calls.map(call => call[0].url)).toEqual(['/api/public/talk/7', '/api/public/talk/72']);
    expect(screen.getByRole('link', {name: '查看全部说说'})).toBeTruthy();
});

it('keeps loaded talk cards during a failed next page and never displays a false empty state', async () => {
    api.mockResolvedValueOnce(response({items: [talk(8)], nextCursor: 'talk-next'}))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(response({items: [talk(7)], nextCursor: null}));
    mount(<Talks />, '/talk');
    await screen.findByText('说说8');
    fireEvent.click(screen.getByRole('button', {name: /加载更多说说/}));
    await screen.findByRole('alert');
    expect(screen.getByText('说说8')).toBeTruthy();
    expect(screen.queryByText('还没有说说')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: /重\s*试/}));
    await screen.findByText('说说7');
    expect(screen.getByText('说说8')).toBeTruthy();
    await waitFor(() => expect(api.mock.calls.map(call => call[0].params.cursor))
        .toEqual([null, 'talk-next', 'talk-next']));
});

it.each(['abc', '-1', '1.5', '2147483648'])('ignores invalid deep link %s without querying an invalid ID', async tk => {
    api.mockResolvedValue(response({items: [], nextCursor: null}));
    mount(<Talks />, `/talk?tk=${tk}`);
    await screen.findByText('还没有说说');
    expect(api.mock.calls.map(call => call[0].url)).toEqual(['/api/public/talk/feed']);
});

it('does not accept HTTP 200 with a failed business result as an empty feed', async () => {
    api.mockResolvedValue({status: 200, data: {code: 500, data: {items: [], nextCursor: null}}});
    mount(<Talks />, '/talk');
    await screen.findByRole('alert');
    expect(screen.queryByText('还没有说说')).toBeNull();
    expect(screen.getByRole('button', {name: /重\s*试/})).toBeTruthy();
});
