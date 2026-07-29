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

  await Promise.all([
    loadExternalResource(live2d_path + 'waifu.css', 'css'),
    loadExternalResource(live2d_path + 'waifu-tips.js', 'js')
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
    tools: ['hitokoto', 'asteroids', 'switch-model', 'switch-texture', 'photo', 'info', 'quit'],
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
      const applyParams = (core) => {
        if (!core || typeof core.setParameterValueById !== 'function') return;
        const t = performance.now();
        const set = (name, val) => {
          core.setParameterValueById(name, val, 1.0);
          const cnt = core.getParameterCount();
          for (let i = 0; i < cnt; i++) {
            const pid = core.getParameterId(i);
            if (pid && pid._id && pid._id.s === name) {
              core._parameterValues[i] = val;
              break;
            }
          }
        };
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
            if (core && core && core.update) {
              core._model.update();  // 用我们的参数重新更新渲染器
            }
          };
          model.__customAnimHooked = true;
        }

        // 保底 setInterval
        setInterval(() => { try { applyParams(core); } catch {} }, 50);
        return true;
      };
      const tryStart = () => { if (startAnim()) return; setTimeout(tryStart, 500); };
      tryStart();

      // --- 预留口型控制接口 ---
      window.__setMouthOpen = (value) => {
        try {
          const model = getModel();
          if (!model) return;
          const core = model.getModel ? model.getModel() : model._model;
          if (!core) return;
          const v = Math.max(0, Math.min(1, value));
          core.setParameterValueById('ParamMouthOpenY', v, 1.0);
          core.setParameterValueById('ParamSpeak', v, 1.0);
        } catch {}
      };
      window.__setMouthClose = () => { window.__setMouthOpen(0); };
    })();

    // ── Chat Panel ──
    const chatHTML = `
    <div id="waifu-chat">
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
      

      let pendingNavUrl = '';
      let isSending = false;
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
      // 从 localStorage 加载最近 10 条历史消息
      try {
        const key = 'chat_history_' + (localStorage.getItem('tokenKey') || 'guest');
        const saved = JSON.parse(localStorage.getItem(key) || '[]');
        const recent = saved.slice(-10);
        recent.forEach(item => {
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
            bubble.textContent = item.text;
            content.appendChild(bubble);
          } else {
            content.textContent = item.text;
          }
          div.appendChild(label);
          div.appendChild(content);
          messages.appendChild(div);
        });
        messages.scrollTop = messages.scrollHeight;
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
          bubble.textContent = text;
          content.appendChild(bubble);
        } else {
          content.textContent = text;
        }
        div.appendChild(label);
        div.appendChild(content);
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
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
          const notice = '尊敬的访客：\n\n本站部署的AI虚拟形象Agent（导航/解读助手）仅供技术学习交流与功能展示使用，不视为面向公众开放的经营性AI服务。\n\n为严格遵守《生成式人工智能服务管理暂行办法》等相关法律法规，履行合规义务，本项目已采取访问限制措施，当前未向不特定公众开放。\n\n如您确因学习、交流或前端技术测试需要体验该功能，请通过博客底部或关于页面的联系方式，联系管理员申请临时体验账号。管理员将在确认您的需求后，为您开通限时访问权限。\n\n感谢您的理解与支持！\n我们始终坚持合规先导，也期待与各位爱好者共同交流学习。\n\nSaudade Blog\n2026年7月29日';
          addMsg(notice, 'agent');
          return;
        }

        input.value = '';
        addMsg(msg, 'user');
        isSending = true;
        sendBtn.disabled = true;
        input.disabled = true;

        try {
          const resp = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ 
              message: msg, 
              current_url: window.location.href, 
              page_title: document.title 
            }),
          });
          const data = await resp.json();
          if (data.success) {
            // 流式输出 + 口型同步
            const fullText = data.reply;
            // 创建消息 DOM（不经过 addMsg，避免空消息存到 localStorage）
            const msgs = document.getElementById('chat-messages');
            const div = document.createElement('div');
            div.className = 'chat-msg agent';
            const label = document.createElement('span');
            label.className = 'msg-label';
            label.textContent = '泠月喵: ';
            const contentSpan = document.createElement('span');
            contentSpan.className = 'msg-text';
            div.appendChild(label);
            div.appendChild(contentSpan);
            msgs.appendChild(div);
            msgs.scrollTop = msgs.scrollHeight;
            
            let charIdx = 0;
            let mouthOpen = false;
            const TICK = 30;
            const CHUNK = 3;
            const typeInterval = setInterval(() => {
              if (charIdx < fullText.length) {
                const showLen = Math.min(charIdx + CHUNK, fullText.length);
                contentSpan.textContent = fullText.slice(0, showLen);
                charIdx = showLen;
                // 口型同步：交替开闭
                mouthOpen = !mouthOpen;
                if (window.__setMouthOpen) window.__setMouthOpen(mouthOpen ? 0.8 : 0.2);
                msgs.scrollTop = msgs.scrollHeight;
              } else {
                clearInterval(typeInterval);
                // 流式结束，口型归位
                if (window.__setMouthOpen) window.__setMouthOpen(0);
                // 最终完整文本保存到 localStorage
                try {
                  const key = 'chat_history_' + (localStorage.getItem('tokenKey') || 'guest');
                  let saved = JSON.parse(localStorage.getItem(key) || '[]');
                  saved.push({text: fullText, type: 'agent', time: Date.now()});
                  if (saved.length > 50) saved = saved.slice(-50);
                  localStorage.setItem(key, JSON.stringify(saved));
                } catch(e) {/* ignore */}
              }
            }, TICK);
            
            // Check if the agent suggests a navigation
            const navMatch = data.reply.match(/(?:转跳|跳转|打开|前往|导航到)\s*(https?:\/\/[^\s，。,.]+)/i);
            const navUrl = (() => {
              const m1 = data.reply.match(/(AUTO_NAVIGATE|NAVIGATE):(https?:\/\/[^\s]+)/);
              if (m1) return m1[2];
              const m2 = data.reply.match(/\[([^\]]+)\]\(((?:https?:)?\/\/)?([^)]+)\)/);
              if (m2) {
                let url = m2[3];
                if (url.startsWith('//')) url = 'https:' + url;
                else if (!url.startsWith('http')) url = 'https://' + url;
                return url;
              }
              const m2b = data.reply.match(/\[([^\]]+)\]\(\/([^)]+)\)/);
              if (m2b) return 'https://saudade.site/' + m2b[2];
              const m3 = data.reply.match(/(?:转跳|跳转|打开|前往|导航到)\s*(https?:\/\/[^\s，。,.]+)/i);
              if (m3) return m3[1];
              return null;
            })();
            if (navUrl) {
              const isDirect = data.reply.startsWith('AUTO_NAVIGATE:');
              if (isDirect) {
                window.location.href = navUrl;
              } else {
                pendingNavUrl = navUrl;
                navQuestion.textContent = '泠月喵建议跳转到: ' + navUrl;
                navConfirm.classList.add('active');
              }
            }
          } else {
            addMsg('出错了: ' + (data.error || '未知错误'), 'error');
          }
        } catch(e) {
          addMsg('网络错误: ' + e.message, 'error');
        }
        isSending = false;
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
      };

      // 将 waifu-tool-hitokoto 改为聊天面板开关
      const repurposeHitokoto = () => {
        const hitokotoBtn = document.getElementById('waifu-tool-hitokoto');
        if (!hitokotoBtn) { setTimeout(repurposeHitokoto, 500); return; }
        hitokotoBtn.title = '对话';
        hitokotoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          chatPanel.classList.toggle('active');
          if (chatPanel.classList.contains('active')) input.focus();
        });
      };
      repurposeHitokoto();

      // 拖动
      let isDragging = false, isResizing = false, sX, sY, sW, sH;
      chatPanel.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
        isDragging = true;
        sX = e.clientX - chatPanel.offsetLeft;
        sY = e.clientY - chatPanel.offsetTop;
      });
      document.addEventListener('mousemove', (e) => {
        if (isDragging) {
          chatPanel.style.left = (e.clientX - sX) + 'px';
          chatPanel.style.top = (e.clientY - sY) + 'px';
          chatPanel.style.right = 'auto';
          chatPanel.style.bottom = 'auto';
        }
        if (isResizing) {
          chatPanel.style.width = Math.max(180, sW + e.clientX - sX) + 'px';
          chatPanel.style.height = Math.max(120, sH + e.clientY - sY) + 'px';
        }
      });
      document.addEventListener('mouseup', () => { isDragging = false; isResizing = false; });
      // 缩放把手
      const rh = document.createElement('div');
      rh.style.cssText = 'position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;background:transparent;z-index:2;';
      rh.innerHTML = '<svg viewBox="0 0 10 10" width="14" height="14"><path d="M0 10 L10 0 L10 10 Z" fill="#ccc"/></svg>';
      rh.addEventListener('mousedown', (e) => { e.stopPropagation(); isResizing = true; sX = e.clientX; sY = e.clientY; sW = chatPanel.offsetWidth; sH = chatPanel.offsetHeight; });
      chatPanel.appendChild(rh);

      sendBtn.addEventListener('click', sendMessage);
      // Auto-resize textarea
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 80) + 'px';
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      document.getElementById('nav-yes').addEventListener('click', () => {
        if (pendingNavUrl) {
          navConfirm.classList.remove('active');
          window.location.href = pendingNavUrl;
          pendingNavUrl = '';
        }
      });
      document.getElementById('nav-no').addEventListener('click', () => {
        navConfirm.classList.remove('active');
        pendingNavUrl = '';
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
            content.textContent = text;
            div.appendChild(label);
            div.appendChild(content);
            messages.appendChild(div);
            messages.scrollTop = messages.scrollHeight;
          }
        }
      });
      observer.observe(tips, { childList: true, subtree: true, characterData: true });
    };
    observeTips();

})();
