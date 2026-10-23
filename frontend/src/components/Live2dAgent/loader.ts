type AgentWindow = Window & {__agentChatInjected?: boolean};
let pending: Promise<void> | undefined;
/** Shared across SPA mounts. Only script load success commits the loaded flag. */
export function loadAgent(): Promise<void> {
    if (pending) return pending;
    if ((window as AgentWindow).__agentChatInjected) return Promise.resolve();
    pending = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await new Promise(resolve => window.setTimeout(resolve, attempt * 1500));
            try {
                await new Promise<void>((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = '/live2d-widgets/boot.js?v=20261023a';
                    script.async = true;
                    const fail = () => {
                        window.clearTimeout(timer);
                        script.onload = script.onerror = null;
                        script.remove();
                        reject(new Error('看板娘加载失败'));
                    };
                    const timer = window.setTimeout(fail, 15_000);
                    script.onerror = fail;
                    script.onload = () => {
                        window.clearTimeout(timer);
                        script.onload = script.onerror = null;
                        resolve();
                    };
                    document.head.appendChild(script);
                });
                (window as AgentWindow).__agentChatInjected = true;
                return;
            } catch (error) {
                if (attempt === 2) throw error;
            }
        }
    })().finally(() => { pending = undefined; });
    return pending;
}
