// ═ Live2dWidget：看板娘渲染相关（与聊天无关，无 ctx 依赖）══
// 由 boot.js 按原时序调用：initCanvas → (initWidget 在 boot 内) →
// guardLive2dHitTest → forceSlideInFromBottom → startCustomAnim。
// 原为 loader 顶层函数/IIFE，20260828o 拆分时机械移动，逻辑零改动；
// 20261001 由 live2d-widget.js 改名（文件名取自上游仓库名）。
(function (g) {
  'use strict';
  g.__waifuWidget = function () {
    // 确保 canvas 尺寸正确
    const initCanvas = () => {
      const c = document.getElementById('live2d');
      if (c) { c.setAttribute('width', '800'); c.setAttribute('height', '800'); }
    };

    // Cubism 模型切换/初始化期间，旧版交互库可能在 core 尚未创建时执行
    // hitTest，导致 getHitAreasCount 访问 null。模型就绪前暂时关闭画布命中，
    // 模型完成后恢复交互。
    // ★ 20260828n 修复：旧实现守卫在 initWidget 之前调用——此时画布尚未创建
    //   （#waifu 模板由 initWidget 注入），`if (!canvas) return` 直接空转，守卫
    //   从未生效（onMouseMove→onTap→hitTest 崩溃仍在）。改为 initWidget 之后
    //   调用 + 每帧持续轮询：模型拆建（switch-model）窗口期自动重新禁命中，
    //   且 resetCanvas 重建画布后对新画布生效（每次 tick 重新 getElementById）。
    const guardLive2dHitTest = () => {
      const canHitTest = () => {
        try {
          const ad = window.__cubism5model;
          const sub = ad && ad.subdelegates && ad.subdelegates.getSize() ? ad.subdelegates.at(0) : null;
          const mgr = sub && sub.getLive2DManager ? sub.getLive2DManager() : null;
          const model = mgr && mgr._models && mgr._models.getSize() ? mgr._models.at(0) : null;
          // 崩溃点（20260828k 用户 F12）：LAppModel.hitTest 读 this._modelSetting.getHitAreasCount()，
          // _modelSetting 在模型加载完成前为 null。注意 CubismModel 本体没有 getHitAreasCount
          // （这版运行时只有 Part/Parameter/Drawable 计数），必须检查 _modelSetting——
          // 与 hitTest 崩溃的访问链严格一致，模型就绪后才放行 pointer-events
          return !!(model && model._modelSetting &&
            typeof model._modelSetting.getHitAreasCount === 'function');
        } catch (e) { return false; }
      };
      const tick = () => {
        const canvas = document.getElementById('live2d');
        if (canvas) canvas.style.pointerEvents = canHitTest() ? '' : 'none';
        requestAnimationFrame(tick);
      };
      tick();
    };

    // 看板娘从底部滑入（等角色真正可绘制后才开始，WAAPI 保证过渡必然可见）：
    // 上游 waifu-tips.20260830.js 在"模型加载完成"时加 waifu-active，但 cubism5 运行时在全部
    // 纹理上传到 GPU 之前（_state != CompleteSetup），update/draw 直接 return——角色首帧
    // 通常晚于加类数百毫秒（冷缓存更久）。若加类即滑：空画布滑上来，角色随后"凭空"
    // 出现在最终位置，看起来没有过渡动画。
    // 方案：rAF 轮询等待 ①waifu-active 已加 ②cubism5 模型 _state===CompleteSetup(22，
    // 下一帧必然绘制角色)——齐备瞬间启动滑入，角色在滑动全程可见。
    // 用 Web Animations API（fill:'backwards'，与 CSS 退场偏移同为 -500px），
    // 不受"插入DOM+加类同帧"样式合并影响；不动 transform，避免覆盖 hover 上浮。
    const forceSlideInFromBottom = () => {
      if (!Element.prototype.animate) return; // 老浏览器依赖 CSS transition 原行为
      // 站内整页转跳（agent 导航命令，见跳转前 chat_nav_slide 标记）：跳过滑入动画
      // 立即到位——刷新/首次访问才滑入，转跳时位置应与转跳前一致（用户感知的
      // "看板娘位置变了"主要来自重新滑入 + 模型重载期间的尺寸抖动）
      let isInternalNav = false;
      try {
        isInternalNav = sessionStorage.getItem('chat_nav_slide') === '1';
        sessionStorage.removeItem('chat_nav_slide');
      } catch(e) {}
      const el0 = document.getElementById('waifu');
      if (isInternalNav && el0) {
        el0.dataset.slideInOnce = '1';
        return;
      }
      const isModelReady = () => {
        try {
          const ad = window.__cubism5model;
          if (!ad || !ad.subdelegates || !ad.subdelegates.getSize()) return false;
          const sub = ad.subdelegates.at(0);
          const mgr = sub.getLive2DManager();
          if (!mgr || !mgr._models || !mgr._models.getSize()) return false;
          // hs.CompleteSetup = 22：模型与全部纹理已上传 GPU，下一帧必然绘制
          return mgr._models.at(0)._state === 22;
        } catch { return false; }
      };
      let activeSince = 0; // waifu-active 出现时刻（用于 25s 兜底：角色始终没就绪就直接滑）
      const tick = () => {
        const el = document.getElementById('waifu');
        if (!el || el.dataset.slideInOnce) return; // 元素未创建（禁用/失败）或已滑过
        if (el.classList.contains('waifu-active')) {
          if (!activeSince) activeSince = performance.now();
          const ready = isModelReady() || performance.now() - activeSince > 25000;
          if (ready) {
            el.dataset.slideInOnce = '1';
            el.animate(
              [{ bottom: '-500px' }, { bottom: '0px' }],
              { duration: 800, easing: 'ease-in-out', fill: 'backwards' }
            );
            return;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };

    // 注入循环动作参数 + 口型接口
    const startCustomAnim = () => {
      const getSub = () => {
        try {
          const ad = window.__cubism5model;
          if (!ad || !ad.subdelegates || !ad.subdelegates.getSize()) return null;
          return ad.subdelegates.at(0);
        } catch {
          return null;
        }
      };

      const getModel = () => {
        try {
          const sub = getSub();
          if (!sub) return null;
          const mgr = sub.getLive2DManager();
          if (!mgr || !mgr._models || !mgr._models.getSize()) return null;
          return mgr._models.at(0);
        } catch {
          return null;
        }
      };

            // --- 直接挂钩 model.update()，在 loadParameters() 之后、_model.update() 之前注入参数 ---
      window.__mouthOverride = -1;

      const applyParams = (core) => {
        if (!core || typeof core.setParameterValueById !== 'function') return;
        const t = performance.now();
        const set = (name, val) => {
          try {
            core.setParameterValueById(name, val, 1.0);
            const cnt = core.getParameterCount();
            for (let i = 0; i < cnt; i++) {
              const pid = core.getParameterId(i);
              if (pid && pid._id && pid._id.s === name) {
                core._parameterValues[i] = val;
                break;
              }
            }
          } catch (e) {}
        };
        // 流式输出时控制口型：ParamSpeak 为该模型自定义说话参数（范围大，×100 后由核心钳制到实际范围），
        // ParamMouthOpenY 为标准嘴部开闭参数（0~1），双保险
        if (window.__mouthOverride >= 0) {
          const mv = Math.max(0, Math.min(1, window.__mouthOverride));
          set('ParamSpeak', mv * 100);
          set('ParamMouthOpenY', mv);
        }
        set('ParamTail', Math.sin(t / 600) * 30);
        set('Param3', (()=>{const p=(t%3000)/3000;return p<0.10?Math.sin(p/0.10*Math.PI*4)*60:0;})());
        set('ParamDaiMao', Math.sin(t / 800) * 100);
        set('ParamHairFront', Math.sin(t / 1200 + 1) * 100);
        set('ParamHairSide', Math.sin(t / 1400 + 2) * 100);
        const blinkPhase = (t % 4500) / 4500;
        const blinkValue = blinkPhase < 0.022 ? Math.sin((blinkPhase / 0.022) * Math.PI) : 0;
        set('ParamEyeLOpen', blinkValue);
        set('ParamEyeROpen', blinkValue);
      };

      const startAnim = () => {
        const model = getModel();
        if (!model) return false;
        const core = model.getModel ? model.getModel() : model._model;
        if (!core) return false;

        if (!model.__customAnimHooked) {
          // 挂钩 model.update() — 在 loadParameters() 重置参数之后立即注入我们的值
          const origModelUpdate = model.update.bind(model);
          model.update = function() {
            origModelUpdate();
            // model.update() 内部流程：loadParameters → motion → physics → _model.update()
            // origModelUpdate 已经调用完毕，现在参数可能已被 _model.update() 固化
            // 所以我们在 origModelUpdate 之后调用 applyParams 并重新触发一次 _model.update()
            applyParams(core);
            if (core && core._model && core._model.update) {
              core._model.update();
            } else if (core && typeof core.update === 'function') {
              core.update();  // 用我们的参数重新更新渲染器
            }
          };
          model.__customAnimHooked = true;
        }

        // 保底 setInterval + 检测模型切换（动态获取当前 core）
        setInterval(() => {
          try {
            const curModel = getModel();
            if (!curModel) return;
            const curCore = curModel.getModel ? curModel.getModel() : curModel._model;
            if (!curCore) return;
            applyParams(curCore);
            // 检测模型是否被切换（新模型没有__customAnimHooked）
            if (!curModel.__customAnimHooked) {
              const origUpdate = curModel.update.bind(curModel);
              curModel.update = function() {
                origUpdate();
                const c = curModel.getModel ? curModel.getModel() : curModel._model;
                if (c) {
                  applyParams(c);
                  if (c && c._model && c._model.update) c._model.update();
                }
              };
              curModel.__customAnimHooked = true;
              console.log('[Live2D] re-hooked new model');
            }
          } catch {}
        }, 50);
        return true;
      };
      const tryStart = () => { if (startAnim()) return; setTimeout(tryStart, 500); };
      tryStart();

      // --- 预留口型控制接口 ---
      window.__setMouthOpen = (value) => {
        // 只设 override，让 applyParams 在下一帧通过正常渲染管线设置 ParamSpeak
        window.__mouthOverride = value;
      };
      window.__setMouthClose = () => { window.__mouthOverride = -1; window.__setMouthOpen(0); };
    };

    return { initCanvas, guardLive2dHitTest, forceSlideInFromBottom, startCustomAnim };
  };
})(typeof window !== 'undefined' ? window : globalThis);
