import { useEffect, useRef, type RefObject } from 'react';
import { coverCrop, createSceneLoop, sceneBudget, WATER_TOP, type RiverQuality } from './sceneBudget';
import riverImage from './assets/night-river.webp';

export { riverImage };
export type Light = { x: number; y: number; depth: number; lit: boolean; phase: number; active?: boolean };
type Options = {
    canvas: RefObject<HTMLCanvasElement>;
    quality: RiverQuality;
    paused: boolean;
    revision: unknown;
    resize(width: number, height: number): void;
    step(dt: number): void;
    lights(): Light[];
};
type Stats = { frames: number; backingPixels: number; fpsLimit: number; paused: boolean; renderer: string };

/** Static scenery is an ordinary image. Only the lower river is rasterized, at a bounded resolution. */
export function useRiverScene(options: Options) {
    const latest = useRef(options);
    useEffect(() => { latest.current = options; });
    const syncRef = useRef<(() => void) | null>(null);
    useEffect(() => {
        const canvas = latest.current.canvas.current as (HTMLCanvasElement & { riverStats?: Stats }) | null;
        const ctx = canvas?.getContext('2d', { alpha: false });
        if (!canvas || !ctx) return;
        const texture = document.createElement('canvas');
        const surface = texture.getContext('2d', { alpha: false });
        if (!surface) return;
        const glow = document.createElement('canvas');
        glow.width = 128; glow.height = 64;
        const g = glow.getContext('2d')!;
        const gradient = g.createRadialGradient(64, 32, 0, 64, 32, 64);
        gradient.addColorStop(0, 'rgba(255,199,111,0.35)');
        gradient.addColorStop(0.35, 'rgba(220,139,57,0.13)');
        gradient.addColorStop(1, 'rgba(189,116,46,0)');
        g.fillStyle = gradient; g.fillRect(0, 0, 128, 64);
        const ripples: { x: number; y: number; born: number }[] = [];
        const image = new Image();
        let alive = true, loaded = false, failed = false, w = 1, h = 1, time = 0;
        let budget = sceneBudget(1, 1, latest.current.quality);
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
        const stats: Stats = { frames: 0, backingPixels: 0, fpsLimit: 24, paused: false, renderer: 'river-strips' };
        canvas.riverStats = stats;
        const draw = (dt: number) => {
            time += dt;
            latest.current.step(dt);
            const cw = canvas.width, ch = canvas.height;
            if (!loaded) { ctx.fillStyle = '#081a25'; ctx.fillRect(0, 0, cw, ch); return; }
            const moving = dt > 0 && !reduced.matches;
            // Texture is already cropped to the same cover geometry as the static background.
            // No sky, mountains, per-lantern filters, gradients, or blur are recomputed here.
            for (let i = 0; i < budget.strips; i++) {
                const y = Math.floor(i * ch / budget.strips);
                const next = Math.floor((i + 1) * ch / budget.strips);
                const depth = i / budget.strips;
                const shift = moving ? Math.sin(time * 0.48 + depth * 30) * (0.35 + depth * 1.5) : 0;
                const inset = 4;
                ctx.drawImage(texture, inset + shift, y, cw, next - y, 0, y, cw, next - y);
            }
            const sx = cw / w, sy = ch / (h * (1 - WATER_TOP));
            for (const light of latest.current.lights()) {
                if (!light.lit) continue;
                const x = light.x * sx, y = (light.y - h * WATER_TOP) * sy;
                const size = 20 + light.depth * 100;
                ctx.globalAlpha = light.active ? 1 : 0.35 + light.depth * 0.5;
                ctx.drawImage(glow, x - size * sx, y - size * sy * 0.12, size * 2 * sx, size * sy * 0.6);
                // Broken vertical reflection: one pre-baked sprite, a handful of narrow strips.
                for (let j = 0; j < 5; j++) {
                    const spread = 1 - j / 6;
                    const drift = moving ? Math.sin(time * 1.2 + j * 2 + light.phase) * 2 : 0;
                    ctx.globalAlpha = (0.2 + light.depth * 0.3) * spread;
                    ctx.drawImage(glow, x - size * sx * spread * 0.35 + drift,
                        y + (7 + j * 7) * sy, size * sx * spread * 0.7, 3 * sy);
                }
            }
            // Pointer ripples share the water surface and expire in scene time (no independent timers).
            for (let i = ripples.length - 1; i >= 0; i--) {
                const ripple = ripples[i], age = time - ripple.born;
                if (age > 2.4) { ripples.splice(i, 1); continue; }
                ctx.strokeStyle = '#c1dbd4'; ctx.lineWidth = 0.6;
                for (let ring = 0; ring < 3; ring++) {
                    const radius = Math.max(0, age * 42 - ring * 9);
                    if (radius < 1) continue;
                    ctx.globalAlpha = (1 - age / 2.4) * (0.35 - ring * 0.07);
                    ctx.beginPath(); ctx.ellipse(ripple.x * sx, (ripple.y - h * WATER_TOP) * sy,
                        radius * sx, radius * sy * 0.24, 0, 0, Math.PI * 2); ctx.stroke();
                }
            }
            // Sparse fireflies are baked radial sprites, not live blur/filter layers.
            for (let i = 0; i < 12; i++) {
                const phase = i * 2.399;
                const x = (0.08 + ((i * 0.618) % 0.84)) * cw + Math.sin(time * 0.22 + phase) * 10;
                const y = (0.05 + ((i * 0.13) % 0.57)) * ch + Math.cos(time * 0.3 + phase) * 6;
                ctx.globalAlpha = 0.18 + (Math.sin(time * 0.8 + phase) + 1) * 0.18;
                ctx.drawImage(glow, x, y, 4 + i % 3, 3 + i % 3);
            }
            ctx.globalAlpha = 1;
            stats.frames++;
        };
        const loop = createSceneLoop({ now: () => performance.now(), request: (fn) => window.requestAnimationFrame(fn),
            cancel: (id) => window.cancelAnimationFrame(id), delay: (fn, ms) => window.setTimeout(fn, ms), clearDelay: (id) => window.clearTimeout(id) }, draw);
        const resize = () => {
            w = window.innerWidth; h = window.innerHeight;
            latest.current.resize(w, h);
            budget = sceneBudget(w, h, latest.current.quality);
            if (canvas.width !== budget.width || canvas.height !== budget.height) {
                canvas.width = budget.width; canvas.height = budget.height;
            }
            texture.width = canvas.width + 8; texture.height = canvas.height;
            if (loaded) {
                const crop = coverCrop(image.naturalWidth, image.naturalHeight, w, h);
                surface.drawImage(image, crop.x, crop.y + crop.height * WATER_TOP,
                    crop.width, crop.height * (1 - WATER_TOP), 0, 0, texture.width, texture.height);
            }
            stats.backingPixels = canvas.width * canvas.height;
            draw(0);
        };
        const sync = () => {
            if (!alive) return;
            const quality = latest.current.quality;
            const expected = sceneBudget(w, h, quality);
            if (expected.width !== budget.width || expected.height !== budget.height || expected.fps !== budget.fps) resize();
            stats.fpsLimit = reduced.matches ? 0 : expected.fps;
            stats.paused = !loaded || failed || document.hidden || latest.current.paused || stats.fpsLimit === 0;
            const root = canvas.closest<HTMLElement>('.rz-cinematic');
            if (root) root.dataset.sceneSleeping = String(stats.paused);
            loop.setRunning(!stats.paused, stats.fpsLimit);
            if (!document.hidden) draw(0);
        };
        syncRef.current = sync;
        image.onload = () => { if (alive) { loaded = true; resize(); sync(); } };
        // A failed asset must not leave a blank river or an endless animation loop.
        image.onerror = () => { if (alive) { failed = true; sync(); canvas.style.opacity = '0'; } };
        image.src = riverImage;
        let resizeTimer = 0;
        const onResize = () => {
            window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(() => { if (alive) { resize(); sync(); } }, 120);
        };
        const onPointer = (event: PointerEvent) => {
            if (stats.paused || event.clientY < h * WATER_TOP) return;
            if ((event.target as Element)?.closest('button, [role="dialog"], .rz-lantern')) return;
            if (ripples.length >= 8) ripples.shift();
            ripples.push({ x: event.clientX, y: event.clientY, born: time });
        };
        resize(); sync();
        window.addEventListener('pointerdown', onPointer, { passive: true });
        window.addEventListener('resize', onResize);
        document.addEventListener('visibilitychange', sync);
        reduced.addEventListener('change', sync);
        return () => {
            alive = false; syncRef.current = null; loop.dispose(); window.clearTimeout(resizeTimer);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('pointerdown', onPointer);
            document.removeEventListener('visibilitychange', sync);
            reduced.removeEventListener('change', sync);
            image.onload = image.onerror = null;
            delete canvas.riverStats;
            texture.width = texture.height = glow.width = glow.height = 0;
        };
    }, []);
    useEffect(() => { syncRef.current?.(); }, [options.quality, options.paused, options.revision]);
}
