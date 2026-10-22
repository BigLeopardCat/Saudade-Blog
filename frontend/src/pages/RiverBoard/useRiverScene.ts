import { useEffect, useRef, type RefObject } from 'react';
import { coverCrop, createSceneLoop, sceneBudget, flameIntensity, reflectionLights, WATER_TOP, type RiverQuality } from './sceneBudget';
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

/** The matte supplies scenery; a refracting normal field and reflected light animate the river itself. */
export function useRiverScene(options: Options) {
    const latest = useRef(options);
    useEffect(() => { latest.current = options; });
    const syncRef = useRef<(() => void) | null>(null);
    useEffect(() => {
        const canvas = latest.current.canvas.current as (HTMLCanvasElement & { riverStats?: Stats }) | null;
        if (!canvas) return;
        const gpu = createWaterRenderer(canvas);
        const ctx = gpu ? null : canvas.getContext('2d', { alpha: false });
        if (!ctx && !gpu) { canvas.style.opacity = '0'; return; }
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
        const ripples: { x: number; y: number; born: number; strength?: number }[] = [];
        const image = new Image();
        let alive = true, loaded = false, failed = false, w = 1, h = 1, time = 0;
        let budget = sceneBudget(1, 1, latest.current.quality);
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
        const stats: Stats = { frames: 0, backingPixels: 0, fpsLimit: 45, paused: false, renderer: gpu ? 'river-refraction' : 'river-strips' };
        canvas.riverStats = stats;
        const draw = (dt: number) => {
            time += dt;
            latest.current.step(dt);
            const cw = canvas.width, ch = canvas.height;
            if (gpu) {
                if (loaded) {
                    for (let i = ripples.length - 1; i >= 0; i--) if (time - ripples[i].born > 3.2) ripples.splice(i, 1);
                    gpu.draw(image, w, h, time, latest.current.lights(), ripples);
                    if (dt > 0) stats.frames++;
                }
                return;
            }
            if (!ctx) return;
            if (!loaded) { ctx.fillStyle = '#081a25'; ctx.fillRect(0, 0, cw, ch); return; }
            const moving = dt > 0 && !reduced.matches;
            // Texture is already cropped to the same cover geometry as the static background.
            // No sky, mountains, per-lantern filters, gradients, or blur are recomputed here.
            for (let i = 0; i < budget.strips; i++) {
                const y = Math.floor(i * ch / budget.strips);
                const next = Math.floor((i + 1) * ch / budget.strips);
                const depth = i / budget.strips;
                const shift = moving ? Math.sin(time * 0.73 + depth * 44) * (1 + depth * 4) + Math.sin(time * 1.3 - depth * 23) * depth * 2 : 0;
                const inset = 4;
                ctx.drawImage(texture, inset + shift, y, cw, next - y, 0, y, cw, next - y);
            }
            const sx = cw / w, sy = ch / (h * (1 - WATER_TOP));
            for (const light of latest.current.lights()) {
                if (!light.lit) continue;
                const x = light.x * sx, y = (light.y - h * WATER_TOP) * sy;
                const size = 20 + light.depth * 100;
                ctx.globalAlpha = flameIntensity(time, light.phase) * (light.active ? 1 : 0.35 + light.depth * 0.5);
                ctx.drawImage(glow, x - size * sx, y - size * sy * 0.12, size * 2 * sx, size * sy * 0.6);
                // Broken vertical reflection: one pre-baked sprite, a handful of narrow strips.
                for (let j = 0; j < 5; j++) {
                    const spread = 1 - j / 6;
                    const drift = moving ? Math.sin(time * 1.2 + j * 2 + light.phase) * 2 : 0;
                    ctx.globalAlpha = flameIntensity(time, light.phase) * (0.2 + light.depth * 0.3) * spread;
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
            if (dt > 0) stats.frames++;
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
        image.onload = () => { if (alive) { loaded = true; gpu?.upload(image); resize(); sync(); } };
        // A failed asset must not leave a blank river or an endless animation loop.
        image.onerror = () => { if (alive) { failed = true; sync(); canvas.style.opacity = '0'; } };
        image.src = riverImage;
        let resizeTimer = 0, lastTrailTime = -1, trailX = -100, trailY = -100;
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
        const onPointerMove = (event: PointerEvent) => {
            if (event.pointerType === 'touch' || stats.paused || event.clientY < h * WATER_TOP || time - lastTrailTime < .13) return;
            if ((event.target as Element)?.closest('button, input, textarea, [role="dialog"], .rz-lantern')) return;
            if (Math.hypot(event.clientX - trailX, event.clientY - trailY) < 20) return;
            lastTrailTime = time; trailX = event.clientX; trailY = event.clientY;
            if (ripples.length >= 8) ripples.shift();
            ripples.push({ x: trailX, y: trailY, born: time, strength: .45 });
        };
        const onContextLost = () => { failed = true; canvas.style.opacity = '0'; sync(); };
        resize(); sync();
        canvas.addEventListener('webglcontextlost', onContextLost);
        window.addEventListener('pointerdown', onPointer, { passive: true });
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        window.addEventListener('resize', onResize);
        document.addEventListener('visibilitychange', sync);
        reduced.addEventListener('change', sync);
        return () => {
            alive = false; syncRef.current = null; loop.dispose(); window.clearTimeout(resizeTimer);
            canvas.removeEventListener('webglcontextlost', onContextLost);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('pointerdown', onPointer);
            window.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('visibilitychange', sync);
            reduced.removeEventListener('change', sync);
            image.onload = image.onerror = null;
            delete canvas.riverStats;
            gpu?.dispose();
            texture.width = texture.height = glow.width = glow.height = 0;
        };
    }, []);
    useEffect(() => { syncRef.current?.(); }, [options.quality, options.paused, options.revision]);
}

/** Surface normals, local wavefronts and reflected light are evaluated together on the GPU. */
function createWaterRenderer(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, powerPreference: 'high-performance' });
    if (!gl) return null;
    const shaders: WebGLShader[] = [];
    const compile = (type: number, source: string) => {
        const shader = gl.createShader(type)!;
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Water shader');
        return shader;
    };
    const program = gl.createProgram()!;
    let buffer: WebGLBuffer | null = null, texture: WebGLTexture | null = null;
    try {
        gl.attachShader(program, compile(gl.VERTEX_SHADER, `
            attribute vec2 position; varying vec2 uv;
            void main(){ uv=vec2(position.x*.5+.5,.5-position.y*.5); gl_Position=vec4(position,0.,1.); }
        `));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `
            precision highp float;
            varying vec2 uv;
            uniform sampler2D scenery;
            uniform vec4 crop;
            uniform vec2 viewport;
            uniform float time;
            uniform int lightCount;
            uniform vec4 lights[24];
            uniform int rippleCount;
            uniform vec4 ripples[8];
            const float waterFraction=.56;
            vec2 normalAt(vec2 p){
                vec2 n=vec2(cos(p.x*17.+p.y*28.-time*1.1)*.12,
                            cos(p.x*6.-p.y*45.+time*.8)*.18);
                n+=vec2(cos(p.x*39.-p.y*61.+time*1.9)*.055,
                        cos(p.x*63.+p.y*83.-time*1.4)*.07);
                for(int i=0;i<8;i++){
                    if(i>=rippleCount)break;
                    vec2 d=p-ripples[i].xy;
                    float r=length(d), age=ripples[i].z;
                    float front=r-age*.16;
                    float envelope=exp(-front*front*900.)*exp(-age*.8)*ripples[i].w;
                    n+=d/max(r,.002)*cos(front*160.)*envelope*.55;
                }
                return n;
            }
            void main(){
                float aspect=viewport.x/viewport.y;
                vec2 p=vec2(uv.x*aspect,uv.y*waterFraction);
                vec2 normal=normalAt(p);
                float depth=smoothstep(0.,.25,uv.y);
                vec2 bent=clamp(uv+normal*vec2(.016,.012)*depth,vec2(.001),vec2(.999));
                vec3 color=texture2D(scenery,crop.xy+bent*crop.zw).rgb;
                // Directional sky reflection catches moving wave crests, rather than painted stripes.
                float crest=pow(max(0.,normal.y*.9+normal.x*.4+.48),5.);
                float moonPath=exp(-pow((uv.x-.65-normal.x*.07)/(.025+uv.y*.12),2.));
                color+=vec3(.17,.23,.25)*crest*depth*(.12+moonPath*.8);
                for(int i=0;i<24;i++){
                    if(i>=lightCount)break;
                    vec4 light=lights[i];
                    float below=uv.y-light.y;
                    float reflectionLength=.065+light.z*.19;
                    float spread=.004+light.z*.013+max(below,0.)*.08;
                    float dx=uv.x-light.x-normal.x*(.018+max(below,0.)*.12);
                    float path=exp(-dx*dx/(spread*spread));
                    float tail=exp(-max(below,0.)/reflectionLength)*smoothstep(-.012,.012,below);
                    float broken=.22+.78*pow(.5+.5*sin(p.y*420.+normal.y*15.+time*.9),3.);
                    float spec=pow(max(0.,normal.y+.55),4.);
                    color+=vec3(1.,.47,.13)*path*tail*light.w*(.18+broken*.55+spec*.3);
                    float pool=exp(-pow(dx/(spread*3.),2.)-pow(below/.018,2.));
                    color+=vec3(.8,.28,.055)*pool*light.w*.18;
                }
                // Blend the distant edge into the matte; near water keeps full refraction and highlights.
                vec3 original=texture2D(scenery,crop.xy+uv*crop.zw).rgb;
                color=mix(original,color,smoothstep(0.,.1,uv.y));
                gl_FragColor=vec4(color/(vec3(1.)+max(color-vec3(1.),vec3(0.))*.35),1.);
            }
        `));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Water link');
        gl.useProgram(program);
        buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program, 'position');
        gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const at = (name: string) => gl.getUniformLocation(program, name);
        const locations = { time: at('time'), crop: at('crop'), viewport: at('viewport'),
            lights: at('lights[0]'), lightCount: at('lightCount'), ripples: at('ripples[0]'), rippleCount: at('rippleCount') };
        const lightValues = new Float32Array(24 * 4), rippleValues = new Float32Array(8 * 4);
        return {
            upload(image: HTMLImageElement) { gl.bindTexture(gl.TEXTURE_2D, texture); gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image); },
            draw(image: HTMLImageElement, width: number, height: number, time: number, lights: Light[], ripples: { x: number; y: number; born: number; strength?: number }[]) {
                gl.viewport(0,0,canvas.width,canvas.height); gl.useProgram(program);
                const rect=coverCrop(image.naturalWidth,image.naturalHeight,width,height);
                gl.uniform4f(locations.crop,rect.x/image.naturalWidth,(rect.y+rect.height*WATER_TOP)/image.naturalHeight,rect.width/image.naturalWidth,rect.height*(1-WATER_TOP)/image.naturalHeight);
                gl.uniform2f(locations.viewport,width,height); gl.uniform1f(locations.time,time);
                const visible=reflectionLights(lights);
                visible.forEach((light,i)=>lightValues.set([light.x/width,(light.y/height-WATER_TOP)/(1-WATER_TOP),light.depth,flameIntensity(time,light.phase)*(light.active?1.25:1)],i*4));
                gl.uniform1i(locations.lightCount,visible.length); gl.uniform4fv(locations.lights,lightValues);
                ripples.slice(-8).forEach((ripple,i)=>rippleValues.set([ripple.x/height,(ripple.y-height*WATER_TOP)/height,time-ripple.born,ripple.strength??1],i*4));
                gl.uniform1i(locations.rippleCount,Math.min(8,ripples.length)); gl.uniform4fv(locations.ripples,rippleValues);
                gl.drawArrays(gl.TRIANGLES,0,6);
            },
            dispose() { shaders.forEach(shader=>gl.deleteShader(shader)); gl.deleteProgram(program); gl.deleteBuffer(buffer); gl.deleteTexture(texture); },
        };
    } catch {
        shaders.forEach(shader=>gl.deleteShader(shader)); gl.deleteProgram(program);
        gl.deleteBuffer(buffer); gl.deleteTexture(texture);
        // A shader failure keeps the static matte visible; context restoration retries on remount.
        return null;
    }
}
