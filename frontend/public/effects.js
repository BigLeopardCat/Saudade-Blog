/**
 * 网页特效 - 樱花/大雨/雪花
 * 独立于 jQuery，轻量级 DOM 粒子动画
 */
(function() {
  'use strict';

  const EFFECTS = {};

  // ---------- 通用粒子引擎 ----------
  class Particle {
    constructor(container, opts) {
      this.el = document.createElement('div');
      this.el.style.cssText = [
        'position:fixed',
        'pointer-events:none',
        'z-index:99999',
        'opacity:0',
      ].join(';');
      container.appendChild(this.el);
      this.x = opts.x || 0;
      this.y = opts.y || -30;
      this.w = opts.w || 10;
      this.h = opts.h || 10;
      this.speedY = opts.speedY || 1;
      this.speedX = opts.speedX || 0;
      this.rotation = opts.rotation || 0;
      this.rotSpeed = opts.rotSpeed || 0;
      this.swingAmp = opts.swingAmp || 0;   // 左右摆动幅度
      this.swingFreq = opts.swingFreq || 0; // 左右摆动频率
      this.opacity = opts.opacity || 1;
      this.life = opts.life || 1;           // 生命周期倍率
      this.age = 0;
      this.baseX = this.x;
      // 初始化样式
      this.el.style.width = this.w + 'px';
      this.el.style.height = this.h + 'px';
      if (opts.bgColor) {
        this.el.style.background = opts.bgColor;
      }
      if (opts.borderRadius) {
        this.el.style.borderRadius = opts.borderRadius;
      }
      if (opts.image) {
        this.el.style.backgroundImage = 'url(' + opts.image + ')';
        this.el.style.backgroundSize = 'cover';
      }
    }

    update() {
      this.age++;
      // 下降
      this.y += this.speedY;
      // 左右摆动
      if (this.swingAmp > 0) {
        this.x = this.baseX + Math.sin(this.age * this.swingFreq) * this.swingAmp;
      } else {
        this.x += this.speedX;
      }
      // 旋转
      this.rotation += this.rotSpeed;
      // 渐入
      const fadeIn = Math.min(this.age / 30, 1);
      // 渐出
      const lifeLeft = Math.max(0, 1 - (this.age / (500 * this.life)));
      this.el.style.opacity = Math.min(this.opacity * fadeIn, this.opacity * lifeLeft);
      // 应用位置
      this.el.style.transform = 'translate(' + this.x + 'px,' + this.y + 'px) rotate(' + this.rotation + 'deg)';
      return this.age < 500 * this.life;
    }

    remove() {
      if (this.el && this.el.parentNode) {
        this.el.parentNode.removeChild(this.el);
      }
    }
  }

  function startEffect(name, spawnFn, maxParticles) {
    if (EFFECTS[name]) return;
    const container = document.createElement('div');
    container.id = 'effect-' + name;
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;';
    document.body.appendChild(container);

    const particles = [];
    let running = true;
    let spawnCounter = 0;

    function tick() {
      if (!running) return;
      spawnCounter++;
      // 生成新粒子
      if (particles.length < maxParticles && spawnCounter % 3 === 0) {
        const p = spawnFn(container);
        if (p) particles.push(p);
      }
      // 更新所有粒子
      for (let i = particles.length - 1; i >= 0; i--) {
        const alive = particles[i].update();
        if (!alive) {
          particles[i].remove();
          particles.splice(i, 1);
        }
      }
      requestAnimationFrame(tick);
    }

    EFFECTS[name] = {
      running: true,
      stop: function() {
        running = false;
        particles.forEach(p => p.remove());
        particles.length = 0;
        if (container.parentNode) container.parentNode.removeChild(container);
        EFFECTS[name] = null;
      }
    };
    tick();
  }

  // ---------- 樱花（右上向左下倾斜飘落）----------
  window.startSakura = function() {
    startEffect('sakura', (container) => {
      const size = 10 + Math.random() * 16;
      const r = 180 + Math.floor(Math.random() * 75);
      const g = 120 + Math.floor(Math.random() * 60);
      const b = 150 + Math.floor(Math.random() * 80);
      return new Particle(container, {
        x: window.innerWidth + 30 + Math.random() * 80,
        y: -50 - Math.random() * 200,
        w: size,
        h: size * 0.7,
        speedY: 1.0 + Math.random() * 1.5,
        speedX: -(1.5 + Math.random() * 2.0),
        rotation: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 8,
        swingAmp: 15 + Math.random() * 25,
        swingFreq: 0.015 + Math.random() * 0.025,
        opacity: 0.7 + Math.random() * 0.3,
        life: 0.8 + Math.random() * 0.6,
        borderRadius: '50% 0 50% 0',
        bgColor: 'rgba(' + r + ',' + g + ',' + b + ',0.85)',
      });
    }, 80);
  };

  window.stopSakura = function() {
    if (EFFECTS.sakura) EFFECTS.sakura.stop();
  };

  // ---------- 大雨（更密集）----------
  window.startRain = function() {
    startEffect('rain', (container) => {
      const len = 20 + Math.random() * 35;
      return new Particle(container, {
        x: Math.random() * (window.innerWidth + 60) - 30,
        y: -40 - Math.random() * 60,
        w: 2,
        h: len,
        speedY: 12 + Math.random() * 16,
        speedX: -(1 + Math.random() * 2),
        opacity: 0.3 + Math.random() * 0.5,
        life: 0.2 + Math.random() * 0.2,
        bgColor: 'rgba(150,180,220,' + (0.3 + Math.random() * 0.5) + ')',
        borderRadius: '0',
      });
    }, 250);
  };

  window.stopRain = function() {
    if (EFFECTS.rain) EFFECTS.rain.stop();
  };

  // ---------- 雪花 ----------
  window.startSnow = function() {
    startEffect('snow', (container) => {
      const size = 3 + Math.random() * 8;
      return new Particle(container, {
        x: Math.random() * (window.innerWidth + 100) - 50,
        y: -20 - Math.random() * 80,
        w: size,
        h: size,
        speedY: 0.3 + Math.random() * 0.8,
        speedX: -0.2 + Math.random() * 0.4,
        rotation: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 2,
        swingAmp: 15 + Math.random() * 30,
        swingFreq: 0.008 + Math.random() * 0.015,
        opacity: 0.5 + Math.random() * 0.5,
        life: 1.2 + Math.random() * 1.0,
        borderRadius: '50%',
        bgColor: 'rgba(255,255,255,0.8)',
      });
    }, 80);
  };

  window.stopSnow = function() {
    if (EFFECTS.snow) EFFECTS.snow.stop();
  };

})();
