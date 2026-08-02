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

  // 真实樱花花瓣图片（方案来源 sakura_fall1，保留原始宽高比）
  const PETAL_SRC = ['/icons/sakura/1.png', '/icons/sakura/2.png', '/icons/sakura/3.png', '/icons/sakura/4.png'];

  // ========== 樱花（snowfall 方式：DOM <img> 飘落）==========
  function createSakuraPetals(count) {
    const container = document.createElement('div');
    container.id = 'effect-sakura-container';
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;';
    document.body.appendChild(container);

    const petals = [];

    for (let i = 0; i < count; i++) {
      const img = new Image();
      img.src = PETAL_SRC[Math.floor(Math.random() * PETAL_SRC.length)];
      img.style.cssText = 'position:absolute;pointer-events:none;opacity:0;';
      const size = 18 + Math.random() * 18; // 真实花瓣细节更丰富，稍大一点
      img.style.width = size + 'px';
      img.style.height = 'auto'; // 保持花瓣原始宽高比
      container.appendChild(img);
      petals.push({
        el: img,
        x: window.innerWidth + 50 + Math.random() * 100,
        y: -50 - Math.random() * 300,
        speedY: 0.8 + Math.random() * 1.8,
        speedX: -(1.2 + Math.random() * 2.5),
        rot: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 8,
        swingPhase: Math.random() * Math.PI * 2,
        swingAmp: 10 + Math.random() * 20,
        opacity: 0.5 + Math.random() * 0.5,
        life: 0,
        maxLife: 800 + Math.random() * 600,
      });
    }
    return { container, petals };
  }

  window.startSakura = function() {
    if (EFFECTS.sakura) return;
    const state = createSakuraPetals(50);
    EFFECTS.sakura = state;

    let spawnTimer = 0;
    function tick() {
      spawnTimer++;
      // 补充新花瓣
      if (state.petals.length < 80 && spawnTimer % 4 === 0) {
        const img = new Image();
        img.src = PETAL_SRC[Math.floor(Math.random() * PETAL_SRC.length)];
        const size = 18 + Math.random() * 18;
        img.style.cssText = 'position:absolute;pointer-events:none;opacity:0;';
        img.style.width = size + 'px';
        img.style.height = 'auto';
        state.container.appendChild(img);
        state.petals.push({
          el: img,
          x: window.innerWidth + 50 + Math.random() * 100,
          y: -50 - Math.random() * 300,
          speedY: 0.8 + Math.random() * 1.8,
          speedX: -(1.2 + Math.random() * 2.5),
          rot: Math.random() * 360,
          rotSpeed: (Math.random() - 0.5) * 8,
          swingPhase: Math.random() * Math.PI * 2,
          swingAmp: 10 + Math.random() * 20,
          opacity: 0.5 + Math.random() * 0.5,
          life: 0,
          maxLife: 800 + Math.random() * 600,
        });
      }

      for (let i = state.petals.length - 1; i >= 0; i--) {
        const p = state.petals[i];
        p.life++;
        if (p.life > p.maxLife || p.x < -200 || p.y > window.innerHeight + 100) {
          if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
          state.petals.splice(i, 1);
          continue;
        }
        p.x += p.speedX;
        p.y += p.speedY;
        p.rot += p.rotSpeed;
        p.x += Math.sin(p.life * 0.02 + p.swingPhase) * p.swingAmp * 0.03;
        const fadeIn = Math.min(p.life / 60, 1);
        const fadeOut = Math.max(0, 1 - (p.life - p.maxLife + 100) / 100);
        p.el.style.opacity = Math.min(fadeIn, fadeOut) * p.opacity;
        p.el.style.transform = `translate(${p.x}px,${p.y}px) rotate(${p.rot}deg)`;
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
