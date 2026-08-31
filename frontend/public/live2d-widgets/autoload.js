// ═ Live2D 看板娘 + 聊天面板入口（20260828o 结构拆分）══
// 职责收敛为：防重入 / 资源链加载 / 子模块（chat-core/render/engine/stream/
// live2d-widget）按依赖序加载与组装 / 看板娘初始化时序 / 欢迎语注入。
// 聊天逻辑分布：chat-core（纯函数）→ chat-render（渲染）→ chat-engine（数据层）→
// chat-stream（交互层）。改聊天逻辑不用再动本文件，版本号只 bump 一处（VER）。
(async () => {
  // ═ 前端错误上报（20260830，监控补齐 B）══
  // 全局 JS 异常 / 未捕获 Promise / API 失败（fetch 包装）→ POST /api/monitor/log
  // （keepalive，Rust 落盘 logs/frontend/monitor.log）。注册在防重入分支之前：看板娘
  // 初始化失败（子模块加载 return）也要能上报。策略（20260830f 改全量）：仅同 key
  // （type+message 前 80 字+url）会话内去重防同一 bug 刷屏，去掉条数限制，截断放宽
  // （message 2000/stack 4000）——用户要求全量前端日志便于追踪 agent 问题；AbortError
  // （停止生成/超时 abort）是正常用户操作不报；上报自身（/api/monitor/log）不报防循环。
  (function () {
    const REPORT_URL = '/api/monitor/log';
    const seen = new Set();

    function report(payload) {
      const key = (payload.type || '') + '|' + String(payload.message || '').slice(0, 80) + '|' + (payload.url || '');
      if (seen.has(key)) return;
      seen.add(key);
      let token = '';
      try { token = localStorage.getItem('tokenKey') || ''; } catch (e) { /* 隐私模式等 */ }
      const body = JSON.stringify({
        type: payload.type,
        message: String(payload.message || '').slice(0, 2000),
        stack: String(payload.stack || '').slice(0, 4000),
        url: payload.url || location.href,
      });
      try {
        fetch(REPORT_URL, {
          method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
          body,
        });
      } catch (e) { /* 上报自身失败静默 */ }
    }

    window.addEventListener('error', function (e) {
      report({
        type: 'js_error',
        message: e.message || 'UnknownError',
        stack: e.error && e.error.stack,
        // filename 为空（如 eval 内抛错）时退化为页面 URL，避免上报无意义的 ":1"
        url: (e.filename || location.href) + (e.filename && e.lineno ? ':' + e.lineno : ''),
      });
    });
    window.addEventListener('unhandledrejection', function (e) {
      const r = e.reason;
      report({
        type: 'unhandled_rejection',
        message: (r && (r.message || r)) || String(r),
        stack: r && r.stack,
      });
    });
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        const url = (typeof input === 'string' ? input : (input && input.url) || '');
        return origFetch.apply(this, arguments).then(function (resp) {
          if (url.indexOf('/api/') === 0 && url.indexOf(REPORT_URL) !== 0 && resp.status >= 400) {
            report({ type: 'http_status', message: resp.status + ' ' + url, url: url });
          }
          return resp;
        }).catch(function (err) {
          if (url.indexOf(REPORT_URL) !== 0 && !(err && err.name === 'AbortError')) {
            report({ type: 'fetch_fail', message: (err && err.message) || String(err), url: url });
          }
          throw err;
        });
      };
    }
    window.__reportError = report;
  })();

  // 20260828g：防重入升级为 window 标记 + DOM 存在双保险。旧逻辑只查 #waifu
  // 存在性——若看板娘 DOM 被外部（组件卸载/路由清理）移除，二次注入会完整重
  // 初始化 → 旧实例的 BroadcastChannel/storage/scroll 监听器全部残留 → 双实例
  // 竞态（SPA 跳转后记录乱、滚动对抗的隐性根因）。标记与 DOM 无关，刷新时
  // window 重置自动恢复；bfcache 返回时标记与 DOM 一致保留。
  if (window.__agentChatLoaded || document.getElementById('waifu')) {
    console.log('[Live2D] already loaded, skipping');
    return;
  }
  window.__agentChatLoaded = true;

  // 收起状态恢复：quit 工具会写 waifu-display 24h 标记，上游 initWidget 发现后只建
  // 左下角收回按钮、不初始化看板娘——刷新/返回后看板娘"消失"只剩按钮（曾报
  // "对话按钮跑到收回按钮底部"BUG）。刷新/返回=重新访问，一律清除该标记让看板娘
  // 恢复默认展示；SPA 内路由切换本文件不重跑（上方 skip），不受影响。
  try { localStorage.removeItem('waifu-display'); } catch(e) {}

  const live2d_path = '/live2d-widgets/';
  const modelPath = '/live2d_model/agent_2.model3.json';
  // ★ 版本号：nginx 对 live2d-widgets 目录 immutable 缓存 1 年，子模块变更只 bump
  // 这里一处（所有子模块 URL 统一拼 ?v=VER；Live2dAgent/index.tsx 的 autoload 引用
  // 也需同步 bump——否则浏览器不会重新请求本入口）
  const VER = '20260901b';

  function loadExternalResource(url, type) {
    return new Promise((resolve, reject) => {
      let tag;
      if (type === 'css') {
        tag = document.createElement('link');
        tag.rel = 'stylesheet';
        tag.href = url;
      } else if (type === 'js') {
        tag = document.createElement('script');
        tag.type = 'module';
        tag.src = url;
      }
      if (tag) {
        tag.onload = () => resolve(url);
        tag.onerror = () => reject(url);
        document.head.appendChild(tag);
      }
    });
  }
  // 子模块用常规 script（IIFE + window 挂载，非 module 语法）
  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => resolve(url);
      s.onerror = () => reject(url);
      document.head.appendChild(s);
    });
  }

  const OriginalImage = window.Image;
  window.Image = function(...args) {
    const img = new OriginalImage(...args);
    img.crossOrigin = "anonymous";
    return img;
  };
  window.Image.prototype = OriginalImage.prototype;

  // ── 子模块加载（20260828o 拆分；纯定义，无 DOM 依赖，可并行）──
  const MODS = [
    ['chat-core', '__waifuChatCore'],
    ['chat-render', '__waifuRender'],
    ['chat-engine', '__waifuEngine'],
    ['chat-stream', '__waifuStream'],
    ['live2d-widget', '__waifuWidget'],
  ];
  for (const [name, globalKey] of MODS) {
    try {
      await loadScript(live2d_path + name + '.js?v=' + VER);
    } catch (err) {
      console.error('[agent-chat] 子模块加载失败: ' + name + '.js（' + err + '），聊天功能不可用');
      // 20260830：显式上报（loadScript 内部 catch 了错误，不会走 window error 监听）
      if (window.__reportError) window.__reportError({ type: 'module_load_fail', message: '子模块加载失败: ' + name + '.js', url: live2d_path + name + '.js?v=' + VER });
      return;
    }
    if (typeof window[globalKey] === 'undefined') {
      console.error('[agent-chat] 子模块未注册全局: ' + globalKey + '（' + name + '.js 可能被缓存拦截）');
      if (window.__reportError) window.__reportError({ type: 'module_load_fail', message: '子模块未注册全局: ' + globalKey, url: live2d_path + name + '.js?v=' + VER });
      return;
    }
  }

  // ctx 组装：core = 纯值；render/dom/state/ui 由各工厂按依赖序填充
  const ctx = { ver: VER, core: window.__waifuChatCore, render: {}, dom: {}, state: {}, ui: {} };
  window.__waifuRender(ctx);
  const engine = window.__waifuEngine(ctx);
  if (!engine) { console.error('[agent-chat] chat-engine 初始化失败'); return; }
  window.__waifuStream(ctx, engine);
  const widget = window.__waifuWidget();

  // 提前加载 Cubism 运行时（必须用常规 script 标签，不能用 type=module）
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/cubism5/live2dcubismcore.min.js';
    s.onload = () => resolve(s.src);
    s.onerror = () => reject(s.src);
    document.head.appendChild(s);
  });
  // 确保 Live2DCubismCore 已就绪
  while (typeof window.Live2DCubismCore === 'undefined') {
    await new Promise(r => setTimeout(r, 50));
  }

  // 加载特效脚本（用常规 script 标签，非 module 模式确保全局变量）
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/effects.js';
    s.onload = () => resolve(s.src);
    s.onerror = () => reject(s.src);
    document.head.appendChild(s);
  });

  // 20260830d：waifu-tips 模块图整体重命名（getHitAreasCount null 守卫需要换名
  // 才能越过 nginx 1 年 immutable 缓存）——新名即 cache-bust，无需 ?v=
  await Promise.all([
    loadExternalResource(live2d_path + 'waifu.css?v=' + VER, 'css'),
    loadExternalResource(live2d_path + 'waifu-tips.20260830.js', 'js'),
  ]);

  // 看板娘初始化时序（与拆分前一致：canvas → initWidget → 命中守卫 → 滑入 → 动画）
  widget.initCanvas();

  if (document.getElementById('waifu')) {
    console.warn('[Live2D] waifu already exists, skipping init');
  } else {
  initWidget({
    waifuPath: live2d_path + 'waifu-tips.json',
    cubism5Path: '/cubism5/live2dcubismcore.min.js',
    modelId: 0,
    // A7 修复：移除 'hitokoto' 工具——其回调 fetch v1.hitokoto.cn 后 innerHTML 直插未转义（投稿制内容可带 <svg onload>），
    // 聊天开关按钮由下方 repurposeHitokoto 自建（复用原按钮位 id）
    tools: ['asteroids', 'switch-model', 'switch-texture', 'photo', 'info', 'quit'],
    logLevel: 'trace',
    drag: true,
  }, [{
    paths: [modelPath],
    message: {
      changeSuccess: '模型切换成功。',
      changeFail: '当前只有这一套模型。',
      photo: ['拍照完成啦。'],
      goodbye: ['下次再见。'],
      welcome: ['你好，我已经上线了。'],
      referrer: ['来自 <span>{year}</span> 的问候。'],
      hitokoto: ['今天也要认真摸鱼。'],
    },
  }]);

    }

  // 守卫必须在 initWidget 之后调用：画布由 initWidget 注入 waifu 模板时才创建，
  // 之前调用会因 canvas 不存在而空转（20260828n 修复，见 live2d-widget.js 注释）
  widget.guardLive2dHitTest();

  widget.forceSlideInFromBottom();
  widget.startCustomAnim();

  // 聊天数据层 + 交互层（#waifu 已由 initWidget 创建，engine.init 内部有 500ms 重试兜底）
  engine.init();
  const stream = window.__waifuStream(ctx, engine);
  stream.init();

  // 监听 waifu-tips 的"欢迎阅读"消息，显示在 agent 对话框中
  const observeTips = () => {
    const tips = document.getElementById('waifu-tips');
    if (!tips) { setTimeout(observeTips, 500); return; }
    const observer = new MutationObserver(() => {
      const text = tips.textContent || '';
      // 欢迎语只在文章页（/article/*）显示：首页/列表页的"欢迎阅读「标题」"
      // 语义错位（没有正在阅读的文章），且每次转跳触发都追加会刷屏
      if (text.includes('欢迎阅读') && /^\/article\//.test(location.pathname)) {
        const chatPanel = ctx.dom.chatPanel;
        const messages = ctx.dom.messages;
        if (chatPanel && messages && chatPanel.classList.contains('active')) {
          const div = document.createElement('div');
          div.className = 'chat-msg agent';
          const label = document.createElement('span');
          label.className = 'msg-label';
          label.textContent = '泠月喵: ';
          const content = document.createElement('span');
          content.className = 'msg-text';
          ctx.render.applyMsg(content, text);
          div.appendChild(label);
          div.appendChild(content);
          messages.appendChild(div);
          engine.scrollToBottom(messages);
        }
      }
    });
    observer.observe(tips, { childList: true, subtree: true, characterData: true });
  };
  observeTips();

})();
