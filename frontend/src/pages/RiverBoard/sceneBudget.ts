/** Render budgets are independent of devicePixelRatio and monitor refresh rate. */
export type RiverQuality = 'balanced' | 'cinematic' | 'still';
export const WATER_TOP = 0.52;
export function sceneBudget(width: number, height: number, quality: RiverQuality) {
    const maxWidth = quality === 'cinematic' ? 1440 : 960;
    const scale = Math.min(quality === 'cinematic' ? 0.85 : 0.65, maxWidth / Math.max(1, width));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * (1 - WATER_TOP) * scale)),
        fps: quality === 'still' ? 0 : quality === 'cinematic' ? 30 : 24,
        strips: quality === 'cinematic' ? 48 : 32,
    };
}
export function coverCrop(imageWidth: number, imageHeight: number, width: number, height: number) {
    const scale = Math.max(width / imageWidth, height / imageHeight);
    return { x: (imageWidth - width / scale) / 2, y: (imageHeight - height / scale) / 2,
        width: width / scale, height: height / scale };
}

export interface FrameHost {
    now(): number;
    request(fn: (now: number) => void): number;
    cancel(id: number): void;
    delay(fn: () => void, ms: number): number;
    clearDelay(id: number): void;
}
/** Only one timer/rAF may be live. Pausing cancels both, and resuming never catches up hidden time. */
export function createSceneLoop(host: FrameHost, draw: (dt: number) => void) {
    let raf = 0, timer = 0, running = false, fps = 24, last = 0, deadline = 0;
    const cancel = () => {
        host.cancel(raf); host.clearDelay(timer); raf = timer = 0;
    };
    const frame = (now: number) => {
        raf = 0;
        if (!running) return;
        const dt = Math.min(0.065, Math.max(0, (now - last) / 1000));
        last = now;
        draw(dt);
        if (!running) return;
        const interval = 1000 / fps;
        deadline = Math.max(deadline + interval, now + 1);
        timer = host.delay(() => { timer = 0; raf = host.request(frame); }, Math.max(0, deadline - host.now() - 2));
    };
    return {
        setRunning(active: boolean, framesPerSecond = 24) {
            cancel(); running = active && framesPerSecond > 0; fps = framesPerSecond;
            last = deadline = host.now();
            if (running) raf = host.request(frame);
        },
        dispose() { running = false; cancel(); },
    };
}
