import {beforeEach, describe, expect, it, vi} from 'vitest';
beforeEach(() => {vi.resetModules(); vi.useFakeTimers(); document.head.querySelectorAll('script').forEach(s => s.remove()); delete (window as Window & {__agentChatInjected?: boolean}).__agentChatInjected;});
describe('agent script loading', () => {
    it('shares an in-flight script and commits success only on load', async () => {
        const {loadAgent} = await import('../../src/components/Live2dAgent/loader');
        const first = loadAgent();
        expect(loadAgent()).toBe(first);
        expect(document.head.querySelectorAll('script')).toHaveLength(1);
        expect((window as Window & {__agentChatInjected?: boolean}).__agentChatInjected).toBeUndefined();
        document.head.querySelector('script')!.dispatchEvent(new Event('load'));
        await first;
        await loadAgent();
        expect(document.head.querySelectorAll('script')).toHaveLength(1);
    });
    it('removes a failed script and retries before marking loaded', async () => {
        const {loadAgent} = await import('../../src/components/Live2dAgent/loader');
        const pending = loadAgent();
        document.head.querySelector('script')!.dispatchEvent(new Event('error'));
        await vi.advanceTimersByTimeAsync(1500);
        expect(document.head.querySelectorAll('script')).toHaveLength(1);
        document.head.querySelector('script')!.dispatchEvent(new Event('load'));
        await pending;
        expect((window as Window & {__agentChatInjected?: boolean}).__agentChatInjected).toBe(true);
    });
    it('bounds retries and permits a fresh attempt after exhausted timeouts', async () => {
        const {loadAgent} = await import('../../src/components/Live2dAgent/loader');
        const failure = expect(loadAgent()).rejects.toThrow('看板娘加载失败');
        await vi.advanceTimersByTimeAsync(50_000);
        await failure;
        expect(document.head.querySelector('script')).toBeNull();
        const retry = loadAgent();
        document.head.querySelector('script')!.dispatchEvent(new Event('load'));
        await retry;
    });
});
