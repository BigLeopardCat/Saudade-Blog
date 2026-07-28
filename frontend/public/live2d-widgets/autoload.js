(async () => {
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
        <textarea class="chat-input" id="chat-input" placeholder="和看板娘对话..." rows="1"></textarea>
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

      const addMsg = (text, type) => {
        const div = document.createElement('div');
        div.className = 'chat-msg ' + type;
        const label = document.createElement('span');
        label.className = 'msg-label';
        label.textContent = type === 'user' ? '你: ' : '看板娘: ';
        const content = document.createElement('span');
        content.className = 'msg-text';
        content.textContent = text;
        div.appendChild(label);
        div.appendChild(content);
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
      };

      const sendMessage = async () => {
        const msg = input.value.trim();
        if (!msg || isSending) return;
        input.value = '';
        addMsg(msg, 'user');
        isSending = true;
        sendBtn.disabled = true;
        input.disabled = true;

        try {
          const resp = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              message: msg, 
              current_url: window.location.href, 
              page_title: document.title 
            }),
          });
          const data = await resp.json();
          if (data.success) {
            addMsg(data.reply, 'agent');
            // Check if the agent suggests a navigation
            const navMatch = data.reply.match(/(?:转跳|跳转|打开|前往|导航到)\s*(https?:\/\/[^\s，。,.]+)/i);
            const navUrl = (() => {
              const m1 = data.reply.match(/NAVIGATE:(https?:\/\/[^\s]+)/);
              if (m1) return m1[1];
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
              pendingNavUrl = navUrl;
              navQuestion.textContent = '看板娘建议跳转到: ' + navUrl;
              navConfirm.classList.add('active');
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

      // 注入聊天按钮到工具栏
      const injectChatBtn = () => {
        const tool = document.getElementById('waifu-tool');
        if (!tool) { setTimeout(injectChatBtn, 500); return; }
        const btn = document.createElement('span');
        btn.id = 'waifu-tool-chat';
        btn.title = '对话';
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h10v2H7zm0-3h7v2H7z"/></svg>';
        btn.style.cssText = 'cursor:pointer;display:flex;align-items:center;justify-content:center;padding:4px;';
        btn.addEventListener('click', () => {
          chatPanel.classList.toggle('active');
          if (chatPanel.classList.contains('active')) input.focus();
        });
        tool.appendChild(btn);
      };
      injectChatBtn();

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
})();
