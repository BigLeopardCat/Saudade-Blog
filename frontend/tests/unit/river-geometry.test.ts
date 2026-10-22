import { describe, expect, it } from 'vitest';
import { clampDriftOffset, projectLantern, riverChannel } from '../../src/pages/RiverBoard/riverGeometry';
import { WATER_TOP } from '../../src/pages/RiverBoard/sceneBudget';

describe('lantern positions stay on the central waterway', () => {
    it.each([[1440, 900], [390, 844], [844, 390], [2560, 1080]])('bounds all visible depths, drift and parallax at %sx%s', (w, h) => {
        const view = { w, h };
        for (const d of [-.02, 0, .01, .1, .3, .8, 1, 1.2]) {
            const channel = riverChannel(view, d);
            for (const u of [-1, .13, .5, .87, 2]) {
                for (const offset of [-1e6, -8, 0, 8, 1e6]) {
                    for (const pointer of [0, 1]) {
                        const point = projectLantern(view, { u, d, sway: .8, oX: offset, oY: offset }, 4, pointer);
                        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
                        expect(point.x).toBeGreaterThanOrEqual(channel.center - .74 * channel.halfWidth);
                        expect(point.x).toBeLessThanOrEqual(channel.center + .74 * channel.halfWidth);
                        expect(point.y).toBeGreaterThanOrEqual(h * WATER_TOP + 4);
                        expect(point.y).toBeLessThanOrEqual(h * .94);
                    }
                }
            }
        }
    });
    it('has a finite positive collision derivative even while a far lamp waits for respawn', () => {
        for (const d of [-.02, 0, .001, .5, 1]) {
            const channel = riverChannel({ w: 390, h: 844 }, d);
            expect(channel.depthDerivative).toBeGreaterThan(0);
            expect(Number.isFinite(.5 / channel.depthDerivative)).toBe(true);
        }
    });
    it('projects accumulated offsets identically to bounded collision offsets', () => {
        const view = { w: 1440, h: 900 };
        const lamp = { u: .5, d: .4, sway: 2, oX: 500, oY: -500 };
        const bounded = { ...lamp, oX: clampDriftOffset(lamp.oX), oY: clampDriftOffset(lamp.oY) };
        expect(projectLantern(view, lamp, 2)).toEqual(projectLantern(view, bounded, 2));
        const moved = { ...bounded, d: .8, u: .8 };
        expect(projectLantern(view, moved, 2)).not.toEqual(projectLantern(view, bounded, 2));
    });
    it('handles the zero-size resize boundary without non-finite coordinates', () => {
        const point = projectLantern({ w: 0, h: 0 }, { u: .5, d: 0, sway: 0, oX: 0, oY: 0 }, 0);
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    });
});
