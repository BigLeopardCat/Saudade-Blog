import { describe, expect, it } from 'vitest';
import { flameIntensity, sceneBudget, reflectionLights, WATER_TOP } from '../../src/pages/RiverBoard/sceneBudget';

describe('continuous river scene', () => {
    it('bounds shared flame/reflection brightness and gives lanterns independent phases', () => {
        const first: number[] = [], second: number[] = [];
        for (let i = 0; i < 300; i++) {
            const value = flameIntensity(i / 30, 1.7);
            expect(value).toBeGreaterThanOrEqual(.58);
            expect(value).toBeLessThanOrEqual(1);
            first.push(value);
            second.push(flameIntensity(i / 30, 3.4));
        }
        expect(first).not.toEqual(second);
        expect(Math.max(...first) - Math.min(...first)).toBeGreaterThan(.2);
        expect(flameIntensity(2, 1.7)).toBe(flameIntensity(2, 1.7));
    });
    it('keeps active and nearby lamps reflected even when older lamps fill the uniform budget', () => {
        const far = Array.from({ length: 30 }, (_, id) => ({ id, lit: true, depth: .1, active: false }));
        const near = { id: 50, lit: true, depth: .95, active: false };
        const selected = { id: 60, lit: true, depth: .01, active: true };
        const unlit = { id: 70, lit: false, depth: 1, active: true };
        const input = [...far, near, selected, unlit];
        const chosen = reflectionLights(input);
        expect(chosen).toHaveLength(24);
        expect(chosen[0]).toBe(selected);
        expect(chosen[1]).toBe(near);
        expect(chosen).not.toContain(unlit);
        expect(input[0]).toBe(far[0]);
    });
    it('uses one bounded moving surface budget and a static accessibility state', () => {
        const moving = sceneBudget(3840, 2160, 'cinematic');
        expect(moving.width).toBeLessThanOrEqual(1600);
        expect(moving.height).toBe(Math.round(2160 * (1 - WATER_TOP) * (1600 / 3840)));
        expect(moving.fps).toBeGreaterThanOrEqual(40);
        expect(sceneBudget(390, 844, 'still').fps).toBe(0);
    });
});
