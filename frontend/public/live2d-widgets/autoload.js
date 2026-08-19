(async () => {
  // SPA 路由下如果看板娘已存在则跳过全部初始化
  if (document.getElementById('waifu')) {
    console.log('[Live2D] waifu already exists, skipping');
    return;
  }

  const live2d_path = '/live2d-widgets/';
  const modelPath = '/live2d_model/agent_2.model3.json';

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

  const OriginalImage = window.Image;
  window.Image = function(...args) {
    const img = new OriginalImage(...args);
    img.crossOrigin = "anonymous";
    return img;
  };
  window.Image.prototype = OriginalImage.prototype;

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
  
  await Promise.all([
    loadExternalResource(live2d_path + 'waifu.css?v=20260819a', 'css'),
    loadExternalResource(live2d_path + 'waifu-tips.js', 'js'),
  ]);

  // 确保 canvas 尺寸正确
  const initCanvas = () => {
    const c = document.getElementById('live2d');
    if (c) { c.setAttribute('width', '800'); c.setAttribute('height', '800'); }
  };
  initCanvas();

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
  // 注入循环动作参数 + 口型接口
    (function startCustomAnim() {
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
    })();

    // 剔除 agent 文本中的命令行（NAVIGATE:/AUTO_NAVIGATE:/EFFECT:/DARKMODE:/SUMMARY:），仅用于展示。
    // 前缀正则放宽：模型可能在正文里幻觉输出 SNOW_EFFECT:/TOKK_EFFECT: 等变形工具命令，
    // 一律按命令行剔除，不进入对话框。SYSTEM 兜底：[System: …] 是模型对系统注记的
    // 复述/幻觉（prompt 已禁止但 qwen 偶发原样透出），同样不展示
    const COMMAND_LINE_RE = /^(?:[A-Za-z0-9_]*EFFECT|DARKMODE|NAVIGATE|AUTO_NAVIGATE|SUMMARY|\[?System)\]?\s*:/;
    const cleanAgentText = (text) => {
      if (!text) return '';
      let cleaned = text.split('\n')
        .filter(l => !COMMAND_LINE_RE.test(l.trim()))
        .join('\n')
        .trim();
      // 兜底：模型格式漂移输出的无前缀裸摘要（与后端 server.py/_strip_summary_from_reply
      // 同一套特征判定）——回复末尾独立段，以"访客/用户/助手"第三人称开头 + 会话时序词
      // + 无互动语气词（剔除引号内内容后检测）+ 长度 40-300（下限滤掉短句正常回复）。
      // 只影响显示；入库记忆由后端剥离（Rust save_assistant_reply 同样兜底）
      const paras = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      if (paras.length > 1) {
        const last = paras[paras.length - 1];
        const noQuote = last.replace(/[“”『』"'「」][^“”『』"'「」]*[“”『』"'「」]/g, '');
        if (/^(访客|用户|助手)/.test(last)
            && /(之前|随后|最后|接着|首先|然后|后来|先后|起初|初期|最终|期间)/.test(last)
            && !/[呜~～!！?？🐱😿🐾😂😭]/.test(noQuote)
            && last.length >= 40 && last.length <= 300) {
          cleaned = paras.slice(0, -1).join('\n\n').trim();
        }
      }
      return cleaned;
    };

    // 渲染消息内容并应用渲染后增强（代码高亮 + 公式，与博客插件一致）
    const applyMsg = (el, text) => {
      el.innerHTML = renderMarkdown(text);
      try {
        if (window.__chatEnhance && typeof window.__chatEnhance === 'function') {
          window.__chatEnhance(el);
        }
      } catch(e) {}
    };

    // ── Markdown 渲染 ──
    // 优先复用博客文章同款渲染器（由前端 src/utils/chatMarkdown.ts 注册的全局，
    // 与 bytemd Viewer 同一套 unified 管线，gfm 删除线/任务列表/表格等全部支持）；
    // 页面未加载时回退自包含迷你实现（先转义保证安全），若加载了 marked 也支持。
    const renderMarkdown = (text) => {
      if (!text) return '';
      try {
        if (window.__chatRenderMarkdown && typeof window.__chatRenderMarkdown === 'function') {
          return window.__chatRenderMarkdown(text);
        }
        if (window.marked && typeof window.marked.parse === 'function') {
          return window.marked.parse(text, { breaks: true });
        }
      } catch(e) {}
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const escInline = (s) => {
        s = esc(s);
        s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
        // 图片必须优先于链接匹配
        s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />');
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
        s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        return s;
      };
      let html = '';
      const blocks = text.split(/```/);
      blocks.forEach((block, i) => {
        if (i % 2 === 1) {
          // 代码块：去掉语言标记行
          html += '<pre><code>' + esc(block.replace(/^[^\n]*\n/, '')) + '</code></pre>';
          return;
        }
        block.split(/\n{2,}/).forEach((para) => {
          para = para.trim();
          if (!para) return;
          let m = para.match(/^(#{1,6})\s+(.*)$/);
          if (m) { html += '<h' + m[1].length + '>' + escInline(m[2]) + '</h' + m[1].length + '>'; return; }
          // 表格：首行表头 + 分隔行（|---|）+ 数据行
          const tLines = para.split('\n');
          if (tLines.length >= 2 && /^\s*\|.*\|\s*$/.test(tLines[0]) && /^\s*\|[\s:|-]+\|\s*$/.test(tLines[1])) {
            const rows = tLines.map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
            let t = '<table><thead><tr>' + rows[0].map(c => '<th>' + escInline(c) + '</th>').join('') + '</tr></thead><tbody>';
            rows.slice(2).forEach(r => { t += '<tr>' + r.map(c => '<td>' + escInline(c) + '</td>').join('') + '</tr>'; });
            html += t + '</tbody></table>';
            return;
          }
          if (para.startsWith('> ')) { html += '<blockquote>' + escInline(para.slice(2).replace(/\n/g, '<br>')) + '</blockquote>'; return; }
          if (/^[-*]\s+/.test(para)) {
            html += '<ul>' + para.split('\n').map(li => '<li>' + escInline(li.replace(/^[-*]\s+/, '')) + '</li>').join('') + '</ul>';
            return;
          }
          if (/^\d+\.\s+/.test(para)) {
            html += '<ol>' + para.split('\n').map(li => '<li>' + escInline(li.replace(/^\d+\.\s+/, '')) + '</li>').join('') + '</ol>';
            return;
          }
          html += '<p>' + escInline(para).replace(/\n/g, '<br>') + '</p>';
        });
      });
      return html;
    };

    // ── Chat Panel ──
    const chatHTML = `
    <div id="waifu-chat">
      <div class="chat-drag-bar-t"></div>
      <div class="chat-drag-bar-l"></div>
      <div class="chat-inner-border"></div>
      <div class="chat-close" id="chat-close">×</div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-area">
        <textarea class="chat-input" id="chat-input" placeholder="和泠月喵对话..." rows="1"></textarea>
        <button class="chat-send" id="chat-send">发送</button>
      </div>
      <div class="chat-nav-confirm" id="chat-nav-confirm">
        <div class="nav-question" id="nav-question-text"></div>
        <div class="chat-nav-btns">
          <button class="chat-nav-btn yes" id="nav-yes">确定</button>
          <button class="chat-nav-btn no" id="nav-no">取消</button>
        </div>
      </div>
    </div>
`;

    const initChat = () => {
      const waifu = document.getElementById('waifu');
      if (!waifu) { setTimeout(initChat, 500); return; }
      waifu.insertAdjacentHTML('beforeend', chatHTML);

      const chatPanel = document.getElementById('waifu-chat');
      const messages = document.getElementById('chat-messages');
      const input = document.getElementById('chat-input');
      const sendBtn = document.getElementById('chat-send');
      const navConfirm = document.getElementById('chat-nav-confirm');
      const navQuestion = document.getElementById('nav-question-text');
      

      // 可靠滚动到底部（等待布局完成后执行）
      const scrollToBottom = (el) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight;
          });
        });
      };
      let pendingNavUrl = '';
      let isSending = false;
      // 停止生成：输出中点击发送按钮 → abort 当前流；用户停止后丢弃本轮对话（不加入记忆）
      let streamCtrl = null;
      let stoppedByUser = false;
      let discardTurn = false;
      // 从 JWT 提取用户 ID
      const getUserId = () => {
        try {
          const t = localStorage.getItem('tokenKey');
          if (!t) return '';
          const payload = JSON.parse(atob(t.split('.')[1]));
          return payload.sub || '';
        } catch { return ''; }
      };
      const userLabel = (() => {
        const uid = getUserId();
        return uid ? '用户' + uid + '（你）: ' : '你: ';
      })();
      // 渲染全部历史消息（像聊天软件一样保留完整记录）
      const syncHistory = () => {
        if (isSending) return; // 流式输出中不重绘，避免打断
        try {
          const key = 'chat_history_' + (localStorage.getItem('tokenKey') || 'guest');
          const saved = JSON.parse(localStorage.getItem(key) || '[]');
          messages.innerHTML = '';
          saved.forEach(item => {
            const div = document.createElement('div');
            div.className = 'chat-msg ' + item.type;
            const label = document.createElement('span');
            label.className = 'msg-label';
            label.textContent = item.type === 'user' ? userLabel : '泠月喵: ';
            const content = document.createElement('span');
            content.className = 'msg-text';
            if (item.type === 'user') {
              const bubble = document.createElement('span');
              bubble.className = 'msg-bubble';
              applyMsg(bubble, item.text);
              content.appendChild(bubble);
            } else {
              applyMsg(content, cleanAgentText(item.text));
            }
            div.appendChild(label);
            div.appendChild(content);
            messages.appendChild(div);
          });
          scrollToBottom(messages);
        } catch(e) {/* ignore */}
      };
      // 初始化时渲染历史
      syncHistory();

      // 导航跳转返回后：默认打开对话框并滚动到对话底部
      try {
        if (sessionStorage.getItem('chat_open')) {
          sessionStorage.removeItem('chat_open');
          chatPanel.classList.add('active');
          syncHistory(); // 同步其他页面产生的新对话
          setTimeout(() => scrollToBottom(messages), 60);
        }
      } catch(e) {/* ignore */}

      const addMsg = (text, type) => {
        const div = document.createElement('div');
        div.className = 'chat-msg ' + type;
        const label = document.createElement('span');
        label.className = 'msg-label';
        label.textContent = type === 'user' ? userLabel : '泠月喵: ';
        const content = document.createElement('span');
        content.className = 'msg-text';
        if (type === 'user') {
          const bubble = document.createElement('span');
          bubble.className = 'msg-bubble';
          applyMsg(bubble, text);
          content.appendChild(bubble);
        } else {
          applyMsg(content, text);
        }
        div.appendChild(label);
        div.appendChild(content);
        messages.appendChild(div);
        scrollToBottom(messages);
        // 非流式 agent 消息也触发嘴部动作
        if (type === 'agent') {
          try {
            const ad = window.__cubism5model;
            const sub = ad && ad.subdelegates && ad.subdelegates.getSize() ? ad.subdelegates.at(0) : null;
            const mgr = sub ? sub.getLive2DManager() : null;
            const m = mgr && mgr._models && mgr._models.getSize() ? mgr._models.at(0) : null;
            if (m) {
              const c = m.getModel ? m.getModel() : m._model;
              if (c && typeof c.setParameterValueById === 'function') {
                c.setParameterValueById('ParamSpeak', 70, 1.0);
                c.setParameterValueById('ParamMouthOpenY', 0.7, 1.0);
                if (m.update && typeof m.update === 'function') m.update();
                else if (c._csmUpdateModel) c._csmUpdateModel();
                else if (c._model && c._model.update) c._model.update();
                setTimeout(() => {
                  c.setParameterValueById('ParamSpeak', 0, 1.0);
                  c.setParameterValueById('ParamMouthOpenY', 0, 1.0);
                  if (m.update && typeof m.update === 'function') m.update();
                  else if (c._csmUpdateModel) c._csmUpdateModel();
                  else if (c._model && c._model.update) c._model.update();
                }, Math.min(1500, Math.max(300, text.length * 20)));
              }
            }
          } catch(e) {}
        }
        // 持久化到 localStorage
        try {
          const key = 'chat_history_' + (localStorage.getItem('tokenKey') || 'guest');
          let saved = JSON.parse(localStorage.getItem(key) || '[]');
          saved.push({text, type, time: Date.now()});
          if (saved.length > 50) saved = saved.slice(-50);
          localStorage.setItem(key, JSON.stringify(saved));
        } catch(e) {/* ignore */}
      };
      const sendMessage = async () => {
        const msg = input.value.trim();
        if (!msg || isSending) return;

        // 登录检查
        const token = localStorage.getItem('tokenKey');
        if (!token) {
          const notice = '尊敬的访客：\n\n本站部署的AI虚拟形象Agent（导航/解读助手）仅供技术学习交流与功能展示使用，不视为面向公众开放的经营性AI服务。\n\n为严格遵守《生成式人工智能服务管理暂行办法》等相关法律法规，履行合规义务，本项目已采取访问限制措施，当前未向不特定公众开放。\n\n如您确因学习、交流或前端技术测试需要体验该功能，请通过博客顶部或关于页面的联系方式，联系管理员申请临时体验账号。管理员将在确认您的需求后，为您开通限时访问权限。\n\n感谢您的理解与支持！\n我们始终坚持合规先导，也期待与各位爱好者共同交流学习。\n\nSaudade Blog\n2026年7月29日';
          addMsg(notice, 'agent');
          return;
        }

        input.value = '';
        // 程序清空不会触发 input 事件：主动重置高度，避免空输入框残留多行高度
        // （flex 布局下还会连带拉伸发送按钮导致变形）
        resizeInput();
        addMsg(msg, 'user');
        isSending = true;
        stoppedByUser = false;
        discardTurn = false;
        // 发送按钮切换为"停止生成"（主流对话 UI 形态），点击即中止输出
        sendBtn.disabled = false;
        sendBtn.title = '停止生成';
        sendBtn.innerHTML = '<span class="chat-stop-icon"></span>';
        sendBtn.classList.add('stop-mode');
        input.disabled = true;

        try {
          // SSE 流式对话：agent 首 token 即上屏，不再等待完整回复
          const ctrl = new AbortController();
          streamCtrl = ctrl;
          // 空闲超时：超过 120s 无任何数据帧则中止（正常生成中每帧都会重置）
          let idleTimer = setTimeout(() => ctrl.abort(), 120000);
          const armIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => ctrl.abort(), 120000);
          };
          // 总超时（300s，与后端 STREAM_TOTAL_TIMEOUT 对齐）：agent 工具调用循环等场景
          // 每轮都有帧会重置空闲计时，此计时器不被重置，保证界面必然恢复
          const totalTimer = setTimeout(() => ctrl.abort(), 300000);
          const resp = await fetch('/api/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({
              message: msg,
              current_url: window.location.href,
              page_title: document.title,
              current_effects: (window.__effectStateList || ''), // 实时特效状态，供 agent 感知
              current_darkmode: (window.__darkMode ? 'on' : 'off'), // 实时夜间模式状态（与特效同理），供 agent 感知
            }),
            signal: ctrl.signal,
          });
          if (!resp.ok) {
            // 网关/代理超时可能返回 HTML 错误页（如 504），先读文本再解析
            const text = await resp.text();
            let d = null;
            try { d = JSON.parse(text); } catch(e) {}
            if (resp.status >= 500) throw new Error('服务暂时繁忙（' + resp.status + '），请稍后再试');
            throw new Error((d && d.error) || ('服务响应异常（' + resp.status + '），请稍后再试'));
          }
          if (!resp.body) throw new Error('浏览器不支持流式响应');

          // 创建消息 DOM（不经过 addMsg，避免空消息存到 localStorage）
          const msgs = document.getElementById('chat-messages');
          const div = document.createElement('div');
          div.className = 'chat-msg agent';
          const label = document.createElement('span');
          label.className = 'msg-label';
          label.textContent = '泠月喵: ';
          const contentSpan = document.createElement('span');
          contentSpan.className = 'msg-text';
          contentSpan.classList.add('msg-streaming'); // 流式纯文本阶段用 pre-line 换行
          div.appendChild(label);
          div.appendChild(contentSpan);
          msgs.appendChild(div);
          scrollToBottom(msgs);

          // 消费 SSE：帧 = "data: <payload>\n\n"，payload 为 JSON 编码文本或终端标记
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let displayText = ''; // 展示文本（不含命令行）
          let cmdText = '';     // NAVIGATE:/EFFECT: 命令行（不展示，仅用于解析与历史保存）
          let mouthOpen = false;
          let lastMouthFlip = 0;
          const tickMouth = () => {
            const now = performance.now();
            if (now - lastMouthFlip >= 300) {
              lastMouthFlip = now;
              mouthOpen = !mouthOpen;
              // 闭嘴相位取 0（完全闭合嘴型，模型嘴部与面部同层 PSD）
              window.__mouthOverride = mouthOpen ? 0.8 : 0;
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdle();
            buf += decoder.decode(value, { stream: true });
            let sep;
            while ((sep = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              let payload = frame;
              if (payload.startsWith('data: ')) payload = payload.slice(6);
              if (!payload) continue;
              if (payload.startsWith('__ERROR__:')) {
                let detail = payload.slice(10);
                try { detail = JSON.parse(detail); } catch(e) {}
                throw new Error(detail);
              }
              if (payload === '__END__' || payload === '__NAV_END__') continue;
              let text = payload;
              try { text = JSON.parse(payload); } catch(e) {}
              if (!text) continue;
              // 命令行与展示文本分流：命令行不渲染（含模型幻觉输出的变形命令如 SNOW_EFFECT:）
              if (COMMAND_LINE_RE.test(text)) {
                cmdText += text + '\n';
              } else {
                displayText += text;
                contentSpan.textContent = displayText;
                tickMouth();
                scrollToBottom(msgs);
              }
            }
          }
          clearTimeout(idleTimer);
          clearTimeout(totalTimer);
          // 流结束：口型归位，关闭 override 让模型恢复默认驱动
          if (window.__setMouthOpen) window.__setMouthOpen(0);
          window.__mouthOverride = -1;
          contentSpan.classList.remove('msg-streaming'); // 渲染完成后恢复 normal，与博客一致
          // 完整文本（命令行前置，导航/特效解析与历史保存沿用原格式）
          const fullText = cmdText + displayText;
          // 最终展示：剔除命令行与 SUMMARY 摘要行后渲染 markdown
          applyMsg(contentSpan, cleanAgentText(fullText));
          // 完整文本保存到 localStorage（含命令行，与后端历史一致）
          try {
            const key = 'chat_history_' + (localStorage.getItem('tokenKey') || 'guest');
            let saved = JSON.parse(localStorage.getItem(key) || '[]');
            saved.push({text: fullText, type: 'agent', time: Date.now()});
            if (saved.length > 50) saved = saved.slice(-50);
            localStorage.setItem(key, JSON.stringify(saved));
          } catch(e) {/* ignore */}

            // ── 导航命令解析（命令行优先，正文兜底）──
            // 历史教训：模型幻觉"去X板块"时不在正文里调用 navigate_to，而是手写命令文本
            // （且多为相对路径 AUTO_NAVIGATE:/talk）；旧实现只认完整 URL 且依赖整段
            // startsWith('AUTO_NAVIGATE:')，幻觉命令静默失效并退化为"建议跳转"确认框
            // → 用户看到"没转跳"。因此：① cmdText 命令行锚定解析（AUTO_NAVIGATE→直接跳
            // / NAVIGATE→确认，支持相对路径与格式漂移）；② 无命令行时回退正文链接
            // （确认式，行为不变）。后端强制跳转命令作为流首帧进 cmdText，此处必然命中。
            const cmdNav = (() => {
              for (const line of cmdText.split('\n')) {
                const m = line.match(/^\s*(AUTO_NAVIGATE|NAVIGATE)\s*:\s*((?:https?:)?\/\/[^\s]+|\/[^\s]+)/i);
                if (!m) continue;
                // 去掉行尾中文/ASCII 标点（URL 内合法的 . 必须保留——域名全靠它）
                let url = m[2].replace(/[，。,.?!；;]+$/, '');
                if (url.startsWith('//')) url = 'https:' + url;       // 协议相对 → 补全 scheme
                else if (!/^https?:/i.test(url)) url = 'https://saudade.site' + url; // 相对路径 /talk → 站点根
                if (!/^https?:\/\//i.test(url)) continue;
                return { url, direct: m[1].toUpperCase() === 'AUTO_NAVIGATE' };
              }
              return null;
            })();
            const navUrl = cmdNav ? cmdNav.url : (() => {
              const m1 = fullText.match(/(AUTO_NAVIGATE|NAVIGATE):(https?:\/\/[^\s]+)/);
              if (m1) return m1[2];
              // 站内相对路径必须最先匹配：[文字](/article/16) → 站点根路径
              // （排除 // 开头，避免误吞协议相对地址）
              const m2b = fullText.match(/\[([^\]]+)\]\((\/(?!\/)[^)]+)\)/);
              if (m2b) return 'https://saudade.site' + m2b[2];
              // 完整 URL：scheme 必须存在（http(s):// 或 // 开头），
              // 否则 [文字](/article/16) 会被拼成 https:///article/16 这种坏链接
              const m2 = fullText.match(/\[([^\]]+)\]\(((?:https?:)?\/\/[^)]+)\)/);
              if (m2) {
                let url = m2[2];
                if (url.startsWith('//')) url = 'https:' + url;
                return url;
              }
              // 中文命令 + 裸 URL：排除空白/中日韩字符（URL 内合法的 . 和 , 保留），
              // 仅去掉结尾的 ASCII 标点（避免 https://example.com 被截成 https://example）
              const m3 = fullText.match(/(?:转跳|跳转|打开|前往|导航到)\s*(https?:\/\/[^\s一-鿿　-〿＀-￯]+)/i);
              if (m3) return m3[1].replace(/[,.;!?]+$/, '');
              return null;
            })();
            if (navUrl) {
              const isDirect = !!cmdNav && cmdNav.direct;
              // 防呆：自动整页跳转前校验目标是博客真实路由。agent 可能幻觉出不存在的
              // 页面（如 /iot），跳过去会丢失整站布局与聊天面板（曾导致"文本框卡死"）。
              // 不在白名单内的目标取消跳转，并在对话框追加系统提示。
              const BLOG_ROUTES = [/^\/$/, /^\/about$/, /^\/friends$/, /^\/talk$/, /^\/times$/, /^\/login$/, /^\/dashboard/, /^\/category\//, /^\/article\//, /^\/device-console\//];
              const navPath = (() => { try { return new URL(navUrl).pathname; } catch(e3) { return null; } })();
              const navOk = !!navPath && BLOG_ROUTES.some(r => r.test(navPath));
              // 直接跳转额外校验同源：白名单只查 pathname，幻觉的
              // AUTO_NAVIGATE:https://evil.com/talk 路径合法但会带用户离开本站 → 阻断（降级确认式）
              const hostOk = (() => { try { return new URL(navUrl).host === window.location.host; } catch(e4) { return false; } })();
              if (isDirect) {
                if (!navOk || !hostOk) {
                  console.warn('[agent] 已取消跳转到非博客页面: ' + navUrl);
                  contentSpan.insertAdjacentHTML('beforeend', '<div class="nav-skip-note">（系统：该地址不是博客页面，已取消自动跳转）</div>');
                } else {
                  sessionStorage.setItem('chat_open', '1');  // 跳转后默认打开对话框并滚动到底部
                  window.location.href = navUrl;
                }
              } else {
                pendingNavUrl = navUrl;
                navQuestion.textContent = '泠月喵建议跳转到: ' + navUrl;
                navConfirm.classList.add('active');
              }
            }
            // 处理特效切换命令（支持 EFFECT:name 按钮式切换 / EFFECT:name:on|off 显式开关）
            // 容忍格式漂移：模型可能在正文里输出 "EFFECT: sakura on"（带空格/无冒号分隔）等变形，
            // 一律按显式意图执行；中文/无命令参数（EFFECT: 后跟正文）不会被 \w+ 匹配，安全
            const effectMatch = fullText.match(/EFFECT:\s*(\w+)\s*:?\s*(\w+)?/);
            if (effectMatch) {
              const eff = effectMatch[1];
              const action = effectMatch[2];
              toggleEffect(eff, action);
            }
            // 兜底：模型未真正调用工具、仅把工具调用写进正文时（如 toggle_effect(effect="sakura", action="on")），
            // 按工具调用签名解析并执行，保证特效/夜间模式必定生效
            const toolCall = fullText.match(/toggle_effect\s*\(\s*effect\s*=\s*["'](\w+)["']\s*,?\s*action\s*=\s*["'](on|off)["']\s*\)/i)
              || fullText.match(/toggle_dark_mode\s*\(\s*mode\s*=\s*["'](on|off)["']\s*\)/i);
            if (toolCall) {
              if (toolCall[0].startsWith('toggle_effect')) {
                toggleEffect(toolCall[1], toolCall[2]);
              } else if (toolCall[0].startsWith('toggle_dark_mode')) {
                try { localStorage.setItem('darkModeUserChoice', 'true'); } catch(e2) {/* ignore */}
                applyDarkMode(toolCall[1] === 'on', true);
              }
            }
            // 处理夜间模式命令（DARKMODE:on|off）
            // 通过对话让 agent 调节同样代表访客意愿：标记 darkModeUserChoice，夜间自动切换让位；
            // animate=true 触发与手动点击切换按钮相同的日月过渡动画
            const darkMatch = fullText.match(/DARKMODE:\s*(on|off)/);
            if (darkMatch) {
              try { localStorage.setItem('darkModeUserChoice', 'true'); } catch(e2) {/* ignore */}
              applyDarkMode(darkMatch[1] === 'on', true);
            }
        } catch(e) {
          clearTimeout(idleTimer);
          clearTimeout(totalTimer);
          if (e && e.name === 'AbortError') {
            if (stoppedByUser) {
              // 用户主动停止生成：标记丢弃本轮，清理放在 isSending 复位之后统一执行
              // （syncHistory 在 isSending 时直接 return，此时调用无法重绘）
              discardTurn = true;
            } else {
              addMsg('长时间未收到回复，请稍后重试', 'error');
            }
          } else {
            addMsg('网络错误: ' + e.message, 'error');
          }
        }
        isSending = false;
        streamCtrl = null;
        sendBtn.disabled = false;
        sendBtn.title = '发送';
        sendBtn.innerHTML = '发送';
        sendBtn.classList.remove('stop-mode');
        input.disabled = false;
        input.focus();
        if (discardTurn) {
          // 丢弃本轮用户输入与部分回复（不加入记忆）：
          // 1) 前端 localStorage 历史移除本轮用户消息（部分回复从未写入，仅残留在 DOM）
          // 2) 后端 DB 记忆由 Rust /chat/stream 在流中断时自动清理（chat.rs DiscardAbortedExchange）
          try {
            const key = 'chat_history_' + (localStorage.getItem('tokenKey') || 'guest');
            let saved = JSON.parse(localStorage.getItem(key) || '[]');
            for (let i = saved.length - 1; i >= 0; i--) {
              if (saved[i].type === 'user') { saved.splice(i, 1); break; }
            }
            localStorage.setItem(key, JSON.stringify(saved));
          } catch(e2) {/* ignore */}
          syncHistory();
        }
      };

      // 将 waifu-tool-hitokoto 改为聊天面板开关
      // （hitokoto 工具已从 tools 移除——A7 修复；按钮不存在时自建一个，复用原按钮位 id，保持开关可用）
      const repurposeHitokoto = () => {
        let hitokotoBtn = document.getElementById('waifu-tool-hitokoto');
        if (!hitokotoBtn) {
          const toolBar = document.getElementById('waifu-tool');
          if (!toolBar) { setTimeout(repurposeHitokoto, 500); return; }
          hitokotoBtn = document.createElement('span');
          hitokotoBtn.id = 'waifu-tool-hitokoto';
          hitokotoBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M512 240c0 114.9-114.6 208-256 208c-37.1 0-72.3-6.4-104.1-17.9c-11.9 8.7-31.3 20.6-54.3 30.6C73.6 471.1 44.7 480 16 480c-6.5 0-12.3-3.9-14.8-9.9c-2.5-6-1.1-12.8 3.4-17.4c0 0 0 0 0 0l.3-.3c.3-.3 .7-.7 1.3-1.4c1.1-1.2 2.8-3.1 4.9-5.7c4.1-5 9.6-12.4 15.2-21.6c10-16.6 19.5-38.4 21.4-62.9C17.7 326.8 0 285.1 0 240C0 125.1 114.6 32 256 32s256 93.1 256 208z"/></svg>';
          toolBar.appendChild(hitokotoBtn);
        }
        hitokotoBtn.title = '对话';
        hitokotoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          chatPanel.classList.toggle('active');
          if (chatPanel.classList.contains('active')) {
            syncHistory(); // 每次打开都同步所有页面的聊天记录
            input.focus();
          }
        });
      };
      repurposeHitokoto();
      
      // 看板娘第3按钮（switch-model）→ 切换模型 + 弹出消息
      setTimeout(() => {
        const btn = document.getElementById('waifu-tool-switch-model');
        if (!btn) return;
        btn.title = '更换看板娘';
        btn.addEventListener('click', (e) => {
          // 不阻止默认行为，让库继续执行模型切换
          setTimeout(() => {
            const panel = document.getElementById('waifu-chat');
            if (panel) panel.classList.add('active');
            syncHistory();
            addMsg('目前博客只有泠月喵一个人服务呢，还没有招聘到新员工替本喵顶班~', 'agent');
          }, 100);
        });
      }, 1000);
      
      // 看板娘第4按钮（switch-texture）→ 切换皮肤 + 弹出消息
      setTimeout(() => {
        const btn = document.getElementById('waifu-tool-switch-texture');
        if (!btn) return;
        btn.title = '换装';
        btn.addEventListener('click', (e) => {
          setTimeout(() => {
            const panel = document.getElementById('waifu-chat');
            if (panel) panel.classList.add('active');
            syncHistory();
            addMsg('本喵还没有新衣服呢，要不要给本喵买一件呢~', 'agent');
          }, 100);
        });
      }, 1000);
      
      // 星标按钮（看板娘左侧独立容器）+ 展开特效图标
      const addStarButton = () => {
        // 在 #waifu 左侧创建独立容器
        const waifu = document.getElementById('waifu');
        if (!waifu) { setTimeout(addStarButton, 500); return; }
        const starBox = document.createElement('div');
        starBox.id = 'waifu-tool-star-box';
        starBox.style.cssText = 'position:absolute;left:-10px;top:70px;display:flex;flex-direction:column;gap:5px;align-items:center;opacity:0;transition:opacity 1s;z-index:99;';
        waifu.appendChild(starBox);
        // 鼠标移入 #waifu 时显示
        let expanded = false;
        waifu.addEventListener('mouseenter', () => { starBox.style.opacity = '1'; });
        waifu.addEventListener('mouseleave', () => { 
          // 如果特效菜单展开则不隐藏
          if (!expanded) starBox.style.opacity = '0';
        });
        
        // 星星主按钮
        const starLi = document.createElement('div');
        starLi.style.cssText = 'position:relative;width:25px;height:25px;';
        const starImg = document.createElement('img');
        starImg.src = '/icons/星星.png';
        starImg.style.cssText = 'width:25px;height:25px;cursor:pointer;display:block;';
        starLi.title = '特效';
        starLi.appendChild(starImg);
        starBox.appendChild(starLi);
        
        // 三个子特效图标 — 右侧半圆展开（放在 starBox 中，独立于 starLi）
        // 夜间模式不在此处：博客头部已有独立切换按钮，看板娘侧仅保留 agent 内置 DARKMODE: 命令
        const effects = [
          { src: '/icons/樱花-copy.png', title: '樱花', id: 'effect-sakura', startFn: 'startSakura', stopFn: 'stopSakura' },
          { src: '/icons/大雨.png', title: '大雨', id: 'effect-rain', startFn: 'startRain', stopFn: 'stopRain' },
          { src: '/icons/雪花.png', title: '雪花', id: 'effect-snow', startFn: 'startSnow', stopFn: 'stopSnow' },
        ];
        const effectBtns = [];
        const RADIUS = 40;
        const ANGLE_START = -50;
        const ANGLE_END = 50;
        effects.forEach((eff, idx) => {
          const btn = document.createElement('button');
          btn.className = 'star-sub-btn';
          btn.id = eff.id;
          btn.title = eff.title;
          const angle = ANGLE_START + (ANGLE_END - ANGLE_START) * idx / (effects.length - 1);
          const rad = angle * Math.PI / 180;
          const tx = Math.cos(rad) * RADIUS;
          const ty = Math.sin(rad) * RADIUS;
          btn.style.cssText = 'position:absolute;left:50%;top:50%;margin-left:-15px;margin-top:-15px;width:30px;height:30px;border:none;border-radius:50%;background:rgba(255,255,255,0.15);cursor:pointer;padding:4px;opacity:0;pointer-events:none;transition:all 0.35s cubic-bezier(0.34,1.56,0.64,1);z-index:98;';
          const img = document.createElement('img');
          img.src = eff.src;
          img.style.cssText = 'width:22px;height:22px;display:block;margin:auto;';
          btn.appendChild(img);
          btn.active = false;
          btn._tx = tx;
          btn._ty = ty;
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleEffect(eff.id.replace('effect-', ''));
          });
          starBox.appendChild(btn);
          effectBtns.push(btn);
        });
        
        // 特效实时状态跟踪：手动按钮与 agent 命令都会更新，随对话上报给 agent，
        // 让 agent 感知真实开关状态（避免它只靠自己的调用记忆而失同步）
        window.__effectState = { sakura: false, rain: false, snow: false };
        const syncEffectState = () => {
          window.__effectStateList = Object.keys(window.__effectState).filter(k => window.__effectState[k]).join(',');
        };

        // 全局特效切换函数（按钮/agent 共用）。
        // action 为 'on'/'off' 时按显式意图开关（agent 命令），不会因重复命令翻转状态；
        // 无 action 时保持按钮点击的 toggle 语义
        window.toggleEffect = (name, action) => {
          const effectMap = {
            sakura: { start: 'startSakura', stop: 'stopSakura', id: 'effect-sakura' },
            rain:   { start: 'startRain',   stop: 'stopRain',   id: 'effect-rain' },
            snow:   { start: 'startSnow',   stop: 'stopSnow',   id: 'effect-snow' },
          };
          if (name === 'off') {
            Object.values(effectMap).forEach(e => {
              if (window[e.stop]) window[e.stop]();
              const btn = document.getElementById(e.id);
              if (btn) { btn.active = false; btn.style.filter = 'none'; }
              window.__effectState[e.id.replace('effect-', '')] = false;
            });
            syncEffectState();
            return;
          }
          const eff = effectMap[name];
          if (!eff) return;
          const btn = document.getElementById(eff.id);
          const wantOn = (action === 'on' || action === 'off') ? action === 'on' : null;
          if (wantOn !== null) {
            // agent 显式开关：设置目标状态（start/stop 本身幂等，重复执行安全）
            if (btn) {
              btn.active = wantOn;
              btn.style.filter = wantOn ? 'brightness(1.3) drop-shadow(0 0 3px gold)' : 'none';
            }
            if (wantOn) {
              if (window[eff.start]) window[eff.start]();
            } else {
              if (window[eff.stop]) window[eff.stop]();
            }
            window.__effectState[name] = wantOn;
          } else if (btn) {
            btn.active = !btn.active;
            btn.style.filter = btn.active ? 'brightness(1.3) drop-shadow(0 0 3px gold)' : 'none';
            if (btn.active) {
              if (window[eff.start]) window[eff.start]();
            } else {
              if (window[eff.stop]) window[eff.stop]();
            }
            window.__effectState[name] = btn.active;
          } else {
            // 按钮还没创建时直接调用
            if (window[eff.start]) window[eff.start]();
            window.__effectState[name] = true;
          }
          syncEffectState();
        };
        
        // 星星点击展开/收起 — 右侧半圆动画
        starLi.addEventListener('click', (e) => {
          e.stopPropagation();
          expanded = !expanded;
          if (expanded) {
            effectBtns.forEach((btn, i) => {
              setTimeout(() => {
                btn.style.opacity = '1';
                btn.style.pointerEvents = 'auto';
                btn.style.transform = 'translate(' + btn._tx + 'px, ' + btn._ty + 'px)';
              }, i * 80);
            });
          } else {
            effectBtns.forEach((btn) => {
              btn.style.opacity = '0';
              btn.style.pointerEvents = 'none';
              btn.style.transform = 'translate(0, 0)';
            });
          }
        });
        // 点击其他地方收起
        document.addEventListener('click', (e) => {
          if (expanded && !starLi.contains(e.target)) {
            expanded = false;
            effectBtns.forEach((btn) => {
              btn.style.opacity = '0';
              btn.style.pointerEvents = 'none';
              btn.style.transform = 'translate(0, 0)';
            });
          }
        });
      };
      // 先于 addStarButton 初始化（月亮按钮创建时读取 __darkMode 以同步激活样式）
      try { window.__darkMode = localStorage.getItem('isDarkMode') === 'true'; } catch(e) {/* ignore */}
      // 博客头部手动切换夜间模式（Head handleModeSwitch）也会派发 darkmode-change，
      // 同步 __darkMode 保证 current_darkmode 上报真实状态；本文件 applyDarkMode 派发的事件
      // 到达这里时值相同，幂等无副作用
      window.addEventListener('darkmode-change', (e) => {
        try { window.__darkMode = !!(e && e.detail); } catch(err) {/* ignore */}
      });
      addStarButton();

      // ── 夜间模式控制（agent DARKMODE: 命令 + 夜间自动切换）──
      // 统一入口：持久化状态 + 通知 React 应用（App 监听 darkmode-change 事件同步 isDark）
      // animate=true 时触发与手动点击博客头部切换按钮相同的日月全屏过渡动画
      // （Head 组件监听 moon-sun-animation 事件渲染 MoonToSun）
      const applyDarkMode = (on, animate) => {
        const prev = !!window.__darkMode;
        window.__darkMode = !!on;
        try { localStorage.setItem('isDarkMode', JSON.stringify(!!on)); } catch(e) {/* ignore */}
        try { window.dispatchEvent(new CustomEvent('darkmode-change', { detail: !!on })); } catch(e) {/* ignore */}
        // 状态实际变化且为显式切换（agent 命令/访客操作）才播动画；自动切换静默进行
        try {
          if (animate && !!on !== prev) {
            window.dispatchEvent(new CustomEvent('moon-sun-animation', { detail: on ? 'moon' : 'sun' }));
          }
        } catch(e) {/* ignore */}
      };
      window.applyDarkMode = applyDarkMode;

      // 夜间自动切换：23:00-次日06:00 主动为访客开启夜间模式，其余时段自动恢复日间，
      // 但访客手动选择过（darkModeUserChoice，含对话里让 agent 调节）则尊重访客意愿不覆盖
      const checkNightMode = () => {
        try {
          if (localStorage.getItem('darkModeUserChoice')) return;
          const h = new Date().getHours();
          const night = (h >= 23 || h < 6);
          if (night !== !!window.__darkMode) applyDarkMode(night, false);
        } catch(e) {/* ignore */}
      };
      checkNightMode();
      setInterval(checkNightMode, 10 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNightMode(); });

      // 拖动（仅通过顶部/左侧边框条移动面板，其余区域允许选中文本）
      let isDragging = false, isResizing = false, resizeCorner = 'br', startX, startY, startW, startH, startLeft, startTop, offsetX, offsetY;
      chatPanel.addEventListener('pointerdown', (e) => {
        // 仅在边框条上按下时启动拖动，其余区域不做拦截以便选中/复制文本
        if (!e.target.closest('.chat-drag-bar-t, .chat-drag-bar-l')) return;
        // 阻止事件冒泡到 #waifu（live2d-widgets 的拖拽会冲突）并防止选中文本
        e.stopPropagation();
        e.preventDefault();
        isDragging = true;
        isResizing = false;
        // 固定当前宽度，防止移除 right:0 后宽度变化
        chatPanel.style.width = chatPanel.offsetWidth + 'px';
        offsetX = e.clientX - chatPanel.offsetLeft;
        offsetY = e.clientY - chatPanel.offsetTop;
      });
      document.addEventListener('pointermove', (e) => {
        if (!isDragging && !isResizing) return;
        // 触屏与鼠标同路径：不做视口边界 clamp。
        // （面板定位在 #waifu 内是负坐标，此前触屏 clamp 把初始位置钳到 0 导致
        //   向上拖动被锁死；恢复桌面端一致的自由拖动/缩放）
        if (isDragging) {
          chatPanel.style.left = (e.clientX - offsetX) + 'px';
          chatPanel.style.top = (e.clientY - offsetY) + 'px';
          chatPanel.style.right = 'auto';
          chatPanel.style.bottom = 'auto';
        }
        if (isResizing) {
          if (resizeCorner === 'tl') {
            // 左上角缩放：固定右下角不动，左上角跟随指针
            const w = Math.max(260, startW + (startX - e.clientX));
            const h = Math.max(180, startH + (startY - e.clientY));
            chatPanel.style.width = w + 'px';
            chatPanel.style.height = h + 'px';
            chatPanel.style.left = (startLeft - (w - startW)) + 'px';
            chatPanel.style.top = (startTop - (h - startH)) + 'px';
            chatPanel.style.right = 'auto';
            chatPanel.style.bottom = 'auto';
          } else {
            chatPanel.style.width = Math.max(260, startW + e.clientX - startX) + 'px';
            chatPanel.style.height = Math.max(180, startH + e.clientY - startY) + 'px';
          }
        }
      });
      document.addEventListener('pointerup', () => { isDragging = false; isResizing = false; });
      // 缩放把手：右下角 + 左上角（红色三角，与发送按钮同色）
      const makeResizeHandle = (corner) => {
        const isTL = corner === 'tl';
        const h = document.createElement('div');
        // flex 对齐使 svg 贴住对应角：TL 贴左上角、BR 贴右下角，两个把手样式完全一致
        h.style.cssText = 'position:absolute;' + (isTL ? 'left:0;top:0' : 'right:0;bottom:0') +
          ';width:24px;height:24px;cursor:nwse-resize;background:transparent;z-index:5;touch-action:none;' +
          ';display:flex;' + (isTL ? 'align-items:flex-start;justify-content:flex-start' : 'align-items:flex-end;justify-content:flex-end');
        // 三角形方向：BR 角朝左上，TL 角朝右下（圆角三角：stroke-linejoin:round）
        h.innerHTML = isTL
          ? '<svg viewBox="0 0 10 10" width="22" height="22"><path d="M0 0 L10 0 L0 10 Z" fill="#e74c3c" stroke="#e74c3c" stroke-width="1.5" stroke-linejoin="round" opacity="0.85"/></svg>'
          : '<svg viewBox="0 0 10 10" width="22" height="22"><path d="M0 10 L10 0 L10 10 Z" fill="#e74c3c" stroke="#e74c3c" stroke-width="1.5" stroke-linejoin="round" opacity="0.85"/></svg>';
        h.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          isDragging = false;
          isResizing = true;
          resizeCorner = isTL ? 'tl' : 'br';
          startX = e.clientX;
          startY = e.clientY;
          startW = chatPanel.offsetWidth;
          startH = chatPanel.offsetHeight;
          startLeft = chatPanel.offsetLeft;
          startTop = chatPanel.offsetTop;
        });
        chatPanel.appendChild(h);
      };
      makeResizeHandle('br');
      makeResizeHandle('tl');

      sendBtn.addEventListener('click', () => {
        if (isSending) {
          // 输出中点击 = 停止生成
          stoppedByUser = true;
          if (streamCtrl) streamCtrl.abort();
          // 保险：极端情况下（浏览器对已开始读取的流 abort 不触发 AbortError）catch 不会执行，
          // UI 会卡死在"停止生成"状态——3s 后强制恢复并丢弃本轮，保证界面必能继续使用
          setTimeout(() => {
            if (isSending && stoppedByUser) {
              isSending = false;
              streamCtrl = null;
              sendBtn.disabled = false;
              sendBtn.title = '发送';
              sendBtn.innerHTML = '发送';
              sendBtn.classList.remove('stop-mode');
              input.disabled = false;
              // 与 discardTurn 分支相同的丢弃逻辑（abort 未触发时手动清理）
              try {
                const key = 'chat_history_' + (localStorage.getItem('tokenKey') || 'guest');
                let saved = JSON.parse(localStorage.getItem(key) || '[]');
                for (let i = saved.length - 1; i >= 0; i--) {
                  if (saved[i].type === 'user') { saved.splice(i, 1); break; }
                }
                localStorage.setItem(key, JSON.stringify(saved));
              } catch(e2) {/* ignore */}
              syncHistory();
            }
          }, 3000);
          return;
        }
        sendMessage();
      });
      // 输入框自适应高度：先置 auto 再按内容高度回填，内容为空时回到 min-height
      const resizeInput = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 80) + 'px';
      };
      input.addEventListener('input', resizeInput);
      // IME 输入法合成结束（含取消合成）后兜底重算，防止残留的组合文本高度
      input.addEventListener('compositionend', resizeInput);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      document.getElementById('nav-yes').addEventListener('click', () => {
        if (pendingNavUrl) {
          navConfirm.classList.remove('active');
          sessionStorage.setItem('chat_open', '1');  // 跳转后默认打开对话框并滚动到底部
          window.location.href = pendingNavUrl;
          pendingNavUrl = '';
        }
      });
      document.getElementById('nav-no').addEventListener('click', () => {
        navConfirm.classList.remove('active');
        pendingNavUrl = '';
      });

      // 右上角关闭按钮：收起聊天面板
      document.getElementById('chat-close').addEventListener('click', () => {
        chatPanel.classList.remove('active');
      });
    };
    initChat();



    // 监听 waifu-tips 的"欢迎阅读"消息，显示在 agent 对话框中
    const observeTips = () => {
      const tips = document.getElementById('waifu-tips');
      if (!tips) { setTimeout(observeTips, 500); return; }
      const observer = new MutationObserver(() => {
        const text = tips.textContent || '';
        if (text.includes('欢迎阅读')) {
          const chatPanel = document.getElementById('waifu-chat');
          const messages = document.getElementById('chat-messages');
          if (chatPanel && messages && chatPanel.classList.contains('active')) {
            const div = document.createElement('div');
            div.className = 'chat-msg agent';
            const label = document.createElement('span');
            label.className = 'msg-label';
            label.textContent = '泠月喵: ';
            const content = document.createElement('span');
            content.className = 'msg-text';
            applyMsg(content, text);
            div.appendChild(label);
            div.appendChild(content);
            messages.appendChild(div);
            scrollToBottom(messages);
          }
        }
      });
      observer.observe(tips, { childList: true, subtree: true, characterData: true });
    };
    observeTips();

})();
