/**
 * 网页特效 - 樱花/大雨/雪花
 * 樱花: 基于 snowfall 插件原理，DOM 图片飘落
 * 大雨: Canvas 2D 渲染
 * 雪花: DOM 粒子飘落
 */
(function() {
  'use strict';

  const EFFECTS = {};
  let sakuraAnimId = null, rainAnimId = null, snowAnimId = null;

  // 真实樱花花瓣图片（来源 github.com/WRXinYue/sakura_fall 的 sakura_fall1，保留原始宽高比）
  const PETAL_SRC = ['/icons/sakura/1.png', '/icons/sakura/2.png', '/icons/sakura/3.png', '/icons/sakura/4.png'];

  // ========== 樱花（DOM <img> 飘落）==========
  //
  // 运动模型（20261005 重做）：**风带着花瓣走**，不是"沿一条固定对角线平移"。
  //  - 水平分量 = 每片自己的**风偏**（bias，≈0）+ 一层低频**阵风**（windAmp·cos）。
  //    它在空中左右荡、方向自己会变——既不是一条斜线，也不是直上直下。
  //    旧版是 `speedX` 恒定负值，于是所有花瓣排着队往左下扫，这就是"怪"的来源。
  //  - 竖直分量 = 每片自己的下落速度 vy，再乘一层很轻的"呼吸"（flutter），
  //    下落速度本身在微微起伏——像被风托着，而不是匀速坠。
  //  - 三个频率（阵风/呼吸/翻面）都是**低频**：周期 4–17 秒，肉眼看到的是"飘"而不是"抖"。
  //  - ⚠️ 所有增量都乘 dt（按 60fps 归一）：**刷新率不改变观感**。旧版是"每帧加固定值"，
  //    120Hz 屏上整体快一倍（"速度怪怪的"的另一半来源），别退回那种写法。
  const SAKURA = { initial: 50, max: 80, spawnEvery: 6 };

  function makePetal(container, seedAcrossScreen) {
    const img = new Image();
    img.src = PETAL_SRC[Math.floor(Math.random() * PETAL_SRC.length)];
    img.style.cssText = 'position:absolute;pointer-events:none;opacity:0;';
    const size = 18 + Math.random() * 18; // 真实花瓣细节更丰富，稍大一点
    img.style.width = size + 'px';
    img.style.height = 'auto'; // 保持花瓣原始宽高比
    container.appendChild(img);

    const vy = 0.45 + Math.random() * 0.7; // 下落速度：慢，且每片不同
    return {
      el: img,
      // 从**整幅宽度**里出生（旧版固定从右缘外进来，屏幕左侧永远看不到花瓣从天而降）
      x: -120 + Math.random() * (window.innerWidth + 240),
      // 起始那一批直接铺满整屏：慢速下落要二三十秒才落到底，否则开场是一片空白
      y: seedAcrossScreen ? -60 + Math.random() * (window.innerHeight + 120)
                          : -40 - Math.random() * 320,
      vy,
      windBias: (Math.random() - 0.5) * 0.24,   // 每片一点点固有偏移，整体不偏不倚
      windAmp: 0.30 + Math.random() * 0.45,     // 阵风振幅（px/帧@60fps）
      windFreq: 0.006 + Math.random() * 0.010,  // 阵风周期约 6.5–17s
      flutterAmp: 0.18 + Math.random() * 0.22,  // 下落速度的"呼吸"幅度
      flutterFreq: 0.010 + Math.random() * 0.018,
      flipFreq: 0.008 + Math.random() * 0.020,  // 翻面（scaleX）频率
      swingPhase: Math.random() * Math.PI * 2,
      rot: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 2.4,    // 慢转（旧版 ±4°/帧，转得像贴纸）
      opacity: 0.5 + Math.random() * 0.5,
      life: 0,
      // 寿命按"落完整屏要多久"折算：速度慢的花瓣才不会被寿命提前收走（旧版是写死的 800–1400 帧）
      maxLife: Math.round((window.innerHeight + 360) / vy * (1.3 + Math.random() * 0.7)),
    };
  }

  window.startSakura = function() {
    if (EFFECTS.sakura) return;
    const container = document.createElement('div');
    container.id = 'effect-sakura-container';
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;';
    document.body.appendChild(container);

    const petals = [];
    for (let i = 0; i < SAKURA.initial; i++) {
      const p = makePetal(container, true);
      petals.push(p);
      p.el.style.transform = `translate(${p.x}px,${p.y}px) rotate(${p.rot}deg)`;
    }
    EFFECTS.sakura = { container, petals };

    let last = 0, spawnTimer = 0;
    function tick(now) {
      if (!EFFECTS.sakura) return;
      // dt = 按 60fps 归一的帧长（120Hz 屏上 ≈0.5）。夹住上下限：标签页切回来时
      // rAF 的 now 会跳一大段，不夹的话花瓣会瞬移出去。
      const dt = last ? Math.min(3, Math.max(0.25, (now - last) / 16.667)) : 1;
      last = now;

      spawnTimer += dt;
      if (petals.length < SAKURA.max && spawnTimer >= SAKURA.spawnEvery) {
        spawnTimer = 0;
        petals.push(makePetal(container, false));
      }

      for (let i = petals.length - 1; i >= 0; i--) {
        const p = petals[i];
        p.life += dt;
        const wind = p.windBias + Math.cos(p.life * p.windFreq + p.swingPhase) * p.windAmp;
        p.x += wind * dt;
        p.y += p.vy * (1 + Math.sin(p.life * p.flutterFreq + p.swingPhase) * p.flutterAmp) * dt;
        p.rot += p.rotSpeed * dt;

        if (p.life > p.maxLife || p.y > window.innerHeight + 120 ||
            p.x < -260 || p.x > window.innerWidth + 260) {
          if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
          petals.splice(i, 1);
          continue;
        }
        const fadeIn = Math.min(p.life / 45, 1);
        const fadeOut = Math.max(0, 1 - (p.life - p.maxLife + 90) / 90);
        p.el.style.opacity = Math.min(fadeIn, fadeOut) * p.opacity;
        // 翻面：scaleX 在 0.45–1 之间来回——花瓣被风掀着转，不像一枚平面贴纸在打转
        const flip = 0.45 + 0.55 * Math.abs(Math.cos(p.life * p.flipFreq + p.swingPhase));
        p.el.style.transform =
          `translate(${p.x}px,${p.y}px) rotate(${p.rot}deg) scaleX(${flip.toFixed(3)})`;
      }

      if (EFFECTS.sakura) sakuraAnimId = requestAnimationFrame(tick);
    }
    sakuraAnimId = requestAnimationFrame(tick);
  };

  window.stopSakura = function() {
    if (sakuraAnimId) { cancelAnimationFrame(sakuraAnimId); sakuraAnimId = null; }
    if (EFFECTS.sakura) {
      EFFECTS.sakura.petals.forEach(p => { if (p.el.parentNode) p.el.parentNode.removeChild(p.el); });
      if (EFFECTS.sakura.container.parentNode) EFFECTS.sakura.container.parentNode.removeChild(EFFECTS.sakura.container);
      EFFECTS.sakura = null;
    }
  };

  // ========== 大雨（Canvas 2D）==========
  window.startRain = function() {
    if (EFFECTS.rain) return;
    
    const canvas = document.createElement('canvas');
    canvas.id = 'effect-rain-canvas';
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    let W, H;

    function resize() {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    const drops = [];
    const ripples = [];
    const CONFIG = { rainCount: 300, maxSpeed: 18, minSpeed: 10, maxLength: 25, minLength: 10, wind: 2.5 };

    function rand(min, max) { return Math.random() * (max - min) + min; }

    class Drop {
      constructor() { this.reset(true); }
      reset(anywhere) {
        this.x = rand(-50, W + 50);
        this.y = anywhere && Math.random() > 0.3 ? rand(-H * 0.2, H) : rand(-H, -10);
        this.speed = rand(CONFIG.minSpeed, CONFIG.maxSpeed);
        this.len = rand(CONFIG.minLength, CONFIG.maxLength);
        this.opacity = rand(0.3, 0.9);
        this.width = rand(0.5, 1.8);
      }
      update() {
        this.y += this.speed;
        this.x += CONFIG.wind * 0.3;
        if (this.y > H + 50 || this.x < -100 || this.x > W + 100) this.reset(false);
      }
      draw() {
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.strokeStyle = `rgba(180, 210, 255, ${this.opacity})`;
        ctx.lineWidth = this.width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(this.x, this.y);
        ctx.lineTo(this.x - CONFIG.wind * 0.6, this.y - this.len);
        ctx.stroke();
        ctx.restore();
      }
    }

    class Ripple {
      constructor(x, y) {
        this.x = x; this.y = y;
        this.radius = 2;
        this.maxRadius = rand(18, 35);
        this.speed = rand(1.2, 2.5);
        this.opacity = 1.0;
        this.decay = rand(0.008, 0.025);
        this.alive = true;
      }
      update() {
        this.radius += this.speed;
        this.opacity -= this.decay;
        if (this.opacity <= 0 || this.radius >= this.maxRadius) this.alive = false;
      }
      draw() {
        ctx.save();
        ctx.globalAlpha = this.opacity * 0.6;
        ctx.strokeStyle = 'rgba(200, 225, 255, 0.8)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    for (let i = 0; i < CONFIG.rainCount; i++) {
      const d = new Drop();
      d.x = rand(0, W);
      d.y = rand(0, H);
      drops.push(d);
    }

    EFFECTS.rain = { canvas, drops, ripples, CONFIG, resize };

    function animate() {
      if (!EFFECTS.rain) return;
      ctx.clearRect(0, 0, W, H);
      for (const d of drops) { d.update(); d.draw(); }
      if (Math.random() < 0.02 && drops.length > 0) {
        const src = drops[Math.floor(Math.random() * drops.length)];
        ripples.push(new Ripple(src.x - CONFIG.wind * 0.3, src.y - src.len * 0.3));
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        r.update();
        if (!r.alive) { ripples.splice(i, 1); continue; }
        r.draw();
      }
      // 底部雾效
      const grad = ctx.createLinearGradient(0, H * 0.6, 0, H);
      grad.addColorStop(0, 'rgba(26, 26, 46, 0)');
      grad.addColorStop(1, 'rgba(26, 26, 46, 0.4)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, H * 0.6, W, H * 0.4);
      rainAnimId = requestAnimationFrame(animate);
    }
    rainAnimId = requestAnimationFrame(animate);
  };

  window.stopRain = function() {
    if (rainAnimId) { cancelAnimationFrame(rainAnimId); rainAnimId = null; }
    if (EFFECTS.rain) {
      EFFECTS.rain.canvas.remove();
      window.removeEventListener('resize', EFFECTS.rain.resize);
      EFFECTS.rain = null;
    }
  };

  // ========== 雪花（DOM 粒子）==========
  window.startSnow = function() {
    if (EFFECTS.snow) return;
    const container = document.createElement('div');
    container.id = 'effect-snow-container';
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;';
    document.body.appendChild(container);

    const flakes = [];
    function spawn() {
      if (flakes.length >= 80) return;
      const size = 3 + Math.random() * 8;
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;pointer-events:none;border-radius:50%;opacity:0;';
      el.style.width = size + 'px';
      el.style.height = size + 'px';
      el.style.background = 'rgba(255,255,255,0.8)';
      container.appendChild(el);
      flakes.push({
        el, x: Math.random() * (window.innerWidth + 100) - 50, y: -20 - Math.random() * 80,
        speedY: 0.3 + Math.random() * 0.8, speedX: -0.2 + Math.random() * 0.4,
        rot: Math.random() * 360, rotSpeed: (Math.random() - 0.5) * 2,
        swingPhase: Math.random() * Math.PI * 2, swingAmp: 15 + Math.random() * 30,
        swingFreq: 0.008 + Math.random() * 0.015, opacity: 0.5 + Math.random() * 0.5,
        life: 0, maxLife: 800 + Math.random() * 600,
      });
    }

    for (let i = 0; i < 60; i++) spawn();

    EFFECTS.snow = { container, flakes, spawn };

    let spawnCnt = 0;
    function tick() {
      spawnCnt++;
      if (spawnCnt % 4 === 0 && flakes.length < 80) spawn();
      for (let i = flakes.length - 1; i >= 0; i--) {
        const p = flakes[i];
        p.life++;
        if (p.life > p.maxLife || p.y > window.innerHeight + 50) {
          if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
          flakes.splice(i, 1); continue;
        }
        p.y += p.speedY;
        p.x += p.speedX + Math.sin(p.life * p.swingFreq + p.swingPhase) * p.swingAmp * 0.02;
        p.rot += p.rotSpeed;
        const fadeIn = Math.min(p.life / 40, 1);
        const fadeOut = Math.max(0, 1 - (p.life - p.maxLife + 100) / 100);
        p.el.style.opacity = Math.min(fadeIn, fadeOut) * p.opacity;
        p.el.style.transform = `translate(${p.x}px,${p.y}px) rotate(${p.rot}deg)`;
      }
      if (EFFECTS.snow) snowAnimId = requestAnimationFrame(tick);
    }
    snowAnimId = requestAnimationFrame(tick);
  };

  window.stopSnow = function() {
    if (snowAnimId) { cancelAnimationFrame(snowAnimId); snowAnimId = null; }
    if (EFFECTS.snow) {
      EFFECTS.snow.flakes.forEach(p => { if (p.el.parentNode) p.el.parentNode.removeChild(p.el); });
      if (EFFECTS.snow.container.parentNode) EFFECTS.snow.container.parentNode.removeChild(EFFECTS.snow.container);
      EFFECTS.snow = null;
    }
  };

})();
