/** Render budgets are independent of devicePixelRatio and monitor refresh rate. */
export type RiverQuality = 'cinematic' | 'still';
export const WATER_TOP = 0.54;
export function sceneBudget(width: number, height: number, quality: RiverQuality) {
    const scale = Math.min(1, 1600 / Math.max(1, width));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * (1 - WATER_TOP) * scale)),
        fps: quality === 'still' ? 0 : 45,
        strips: 96,
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
    let raf = 0, timer = 0, running = false, fps = 45, last = 0, deadline = 0;
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
        setRunning(active: boolean, framesPerSecond = 45) {
            cancel(); running = active && framesPerSecond > 0; fps = framesPerSecond;
            last = deadline = host.now();
            if (running) raf = host.request(frame);
        },
        dispose() { running = false; cancel(); },
    };
}

/** Shared by the visible flame and its water reflection; each lantern has a stable phase. */
export function flameIntensity(time: number, phase: number) {
    return 0.79 + 0.11 * Math.sin(time * 7.3 + phase * 2.7)
        + 0.06 * Math.sin(time * 13.7 + phase * 5.1) + 0.04 * Math.sin(time * 3.1 + phase);
}

/** The selected lamp must keep its reflection even in a crowded river. */
export function reflectionLights<T extends { lit: boolean; active?: boolean; depth: number }>(lights: readonly T[]): T[] {
    return lights.filter(light => light.lit)
        .sort((a, b) => Number(!!b.active) - Number(!!a.active) || b.depth - a.depth)
        .slice(0, 24);
}
