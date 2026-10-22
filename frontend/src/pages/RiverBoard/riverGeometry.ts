import { WATER_TOP } from './sceneBudget';

type View = { w: number; h: number };
type FloatingLamp = { u: number; d: number; sway: number; oX: number; oY: number };
const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
export const clampDriftOffset = (value: number) => clamp(finite(value), -8, 8);

/** One river model for drawing and collision response. Never divide by a zero depth derivative. */
export function riverChannel(view: View, depth: number) {
    const w = Math.max(1, finite(view.w, 1)), h = Math.max(1, finite(view.h, 1));
    const d = clamp(finite(depth), 0, 1);
    const horizon = h * WATER_TOP, end = h * .94;
    return {
        center: w * (.52 + .08 * d),
        halfWidth: w * (.08 + .12 * d),
        y: horizon + (end - horizon) * Math.pow(d, 1.42),
        minY: Math.min(end, horizon + 4), maxY: end,
        depthDerivative: Math.max(1, (end - horizon) * 1.42 * Math.pow(Math.max(.02, d), .42)),
    };
}

/** Keep drift, pointer parallax and bobbing inside the same safe central waterway. */
export function projectLantern(view: View, lamp: FloatingLamp, time: number, pointerX = .5) {
    const d = clamp(finite(lamp.d), 0, 1), channel = riverChannel(view, d);
    const phase = finite(time), sway = finite(lamp.sway);
    const u = clamp(finite(lamp.u, .5) + Math.sin(phase * .2 + sway) * .012, .13, .87);
    const parallax = (clamp(finite(pointerX, .5), 0, 1) - .5) * 14 * .28;
    const bob = Math.sin(phase * 1.2 + sway) * 1.6 * (.3 + d);
    return {
        x: clamp(channel.center + (u - .5) * 2 * channel.halfWidth - parallax + clampDriftOffset(lamp.oX),
            channel.center - .74 * channel.halfWidth, channel.center + .74 * channel.halfWidth),
        y: clamp(channel.y - bob + clampDriftOffset(lamp.oY), channel.minY, channel.maxY),
    };
}
