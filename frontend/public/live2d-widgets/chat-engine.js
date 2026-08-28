// ═ ChatEngine：对话数据层（状态机/增量渲染/历史存取/多标签同步）══
// 20260828o 拆分自 autoload.js initChat 巨型闭包（原 583-1180 行）。逻辑零改动，
// 仅将共享符号显式化到 ctx（dom/state）与 engine API，供 chat-stream.js 交互层引用。
// 工厂返回 engine API；init() 在 #waifu 存在后调用（= 原 initChat 主体）。
(function (g) {
  'use strict';
  g.__waifuEngine = function (ctx) {
    if (!ctx || !ctx.core || !ctx.render) {
      console.error('[chat-engine] 缺少 ctx.core/ctx.render——chat-core/chat-render 未加载或加载顺序错误');
      return null;
    }
    const __chatCore = ctx.core;
    const { COMMAND_RE, renderAgentContent, stripCommandPrefix, applyMsg, chatHTML } = ctx.render;

    const api = {};
    const init = () => {
      const waifu = document.getElementById('waifu');
      if (!waifu) { setTimeout(init, 500); return; }
      waifu.insertAdjacentHTML('beforeend', chatHTML);

      const chatPanel = document.getElementById('waifu-chat');
      const messages = document.getElementById('chat-messages');
      if (!messages) {
        // 20260828c 诊断：宿主页面缺聊天面板元素（静态页/结构变更）时所有渲染
        // 静默失败，表现为"对话丢失/不刷新"——显式告警便于定位
        console.error('[agent-chat] #chat-messages 不存在——聊天面板不可用，历史渲染将失败');
      }
      const input = document.getElementById('chat-input');
      const sendBtn = document.getElementById('chat-send');
      const navConfirm = document.getElementById('chat-nav-confirm');
      const navQuestion = document.getElementById('nav-question-text');

      // 交互层（chat-stream）经 ctx.dom 访问的 DOM
      ctx.dom = { waifu, chatPanel, messages, input, sendBtn, navConfirm, navQuestion,
                  newMsgNote: document.getElementById('chat-new-msg-note') };

      // 滚动语义（聊天软件标准，20260828h）：
      // ① 用户在底部（60px 阈值内）→ 新消息自动滚到底（跟随）；
      // ② 用户在历史区（翻看旧记录）→ 新消息不强制拉回（20260828f 诉求），
      //    但显示"↓ 有新消息"指示条——点击回底，滚回底部自动消失；
      // ③ 主动行为（发送消息/打开面板/转跳返回/点击指示条）走 force 路径
      //    无条件回底——"有最新对话就要看到最新位置"（20260828f 之前的问题）。
      // 20260828f 教训：程序滚动触发的 scroll 事件落在底部 → 标志恒 true；
      // 之前只做"不在底部就不滚"，导致翻过历史后新对话永远不可见——补上指示条。
      let userAtBottom = true;
      let newMsgPending = false;
      const newMsgNote = ctx.dom.newMsgNote;
      const showNewMsgNote = () => {
        if (newMsgPending) return;
        newMsgPending = true;
        if (newMsgNote) newMsgNote.classList.add('active');
      };
      const hideNewMsgNote = () => {
        if (!newMsgPending) return;
        newMsgPending = false;
        if (newMsgNote) newMsgNote.classList.remove('active');
      };
      if (newMsgNote) {
        newMsgNote.addEventListener('click', () => scrollToBottom(messages, true));
      }
      try {
        messages.addEventListener('scroll', () => {
          userAtBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
          if (userAtBottom) hideNewMsgNote();
        }, { passive: true });
      } catch(e) {/* ignore */}
      // 可靠滚动到底部（等待布局完成后执行）：force=true 无条件回底并收起指示条；
      // 默认语义尊重用户位置——在底部时跟随，在历史区时转为"有新消息"提示
      const scrollToBottom = (el, force) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!force && !userAtBottom) { showNewMsgNote(); return; }
            hideNewMsgNote();
            el.scrollTop = el.scrollHeight;
          });
        });
      };
      // 执行过程框偏好：默认展开；用户主动收起过一次 → 保持收起（social UI 惯例）
      const getCollapsePref = () => {
        try { return localStorage.getItem('chat_process_collapsed') === '1'; } catch(e) { return false; }
      };
      const setCollapsePref = (collapsed) => {
        try { localStorage.setItem('chat_process_collapsed', collapsed ? '1' : '0'); } catch(e) {}
      };
      // 过程框 DOM 工厂（流式 / 历史恢复共用）：open 决定初始展开态
      const makeProcessBox = (open) => {
        const box = document.createElement('details');
        box.className = 'agent-process';
        box.open = open;
        const summary = document.createElement('summary');
        summary.className = 'agent-process-head';
        const label = document.createElement('span');
        label.className = 'agent-process-label';
        label.textContent = '执行过程';
        const count = document.createElement('span');
        count.className = 'agent-process-count';
        summary.appendChild(label);
        summary.appendChild(count);
        const body = document.createElement('div');
        body.className = 'agent-process-body';
        box.appendChild(summary);
        box.appendChild(body);
        return box;
      };
      // ── 20260828a 重构：内存为唯一渲染数据源，DB/localStorage 只是历史源 ──
      // items：已收尾条目（{id,type,text,time,process?}），id = 'd'+DB主键 / 'l'+随机；
      // live：roundId → 在途气泡句柄（含远端轮）；pendingPull：流式中收到外部变更
      // 信号，流结束后补拉一次（流式中永不 reconcile）；source：'db'（DB 权威）/
      // 'local'（游客/离线，localStorage 权威）。
      ctx.state = {
        pendingNavUrl: '',
        isSending: false,
        // 停止生成：输出中点击发送按钮 → abort 当前流；用户停止后丢弃本轮对话（不加入记忆）
        streamCtrl: null,
        stoppedByUser: false,
        discardTurn: false,
        items: [],
        live: {},
        pendingPull: false,
        source: 'local',
        // 本轮锚点（sendMessage 赋值；3s 保险/停止生成在函数外也能精确清理）
        activeRound: { roundId: '', userItemId: '' },
      };
      const live = ctx.state.live;

      // ── 多标签页同步（聊天软件式：所有窗口同屏同一会话）──
      // 生产端（正在对话的标签页）把每一帧经 BroadcastChannel 广播；接收端按
      // roundId 定位 live 气泡句柄挂帧——本窗轮次与远端轮次 roundId 不同，
      // 双窗并发对话互不干扰（旧版 isSending 整体忽略会互相打断）。
      // done/error 帧带完整条目供远端 mergeItems 转正进内存（远端轮不写
      // localStorage，避免写者风暴；缓存非权威，下次 pull 必然收敛）。无
      // BroadcastChannel 的老浏览器自动降级 storage 事件 + 本地历史。
      const chatChannel = 'BroadcastChannel' in window ? new BroadcastChannel('saudade-chat') : null;
      const broadcast = (m) => { if (chatChannel) chatChannel.postMessage(m); };
      // 20260828s：BroadcastChannel 会把消息发回发送者自己——user 帧在发送窗会
      // mergeItems 同 id 严格替换，把会话内 images（dataURL）换成 hasImg 占位标记
      // （"气泡图片不显示"根因之一）。每个窗口一个随机 id，user 帧带 from 标记，
      // onmessage 收到自己的帧直接跳过。token/done/process 帧经 roundId 幂等无需排除。
      const windowId = Math.random().toString(36).slice(2, 10);
      let remotectlTimer = null; // storage 事件防抖句柄
      // 版本自检：确认浏览器加载的是当前部署脚本（nginx 对 live2d-widgets 缓存 1 年，
      // 未强刷时可能仍在跑旧版——DB 权威历史/roundId 同步只在 20260828a 之后才有）
      console.log('[agent-chat] autoload ' + (ctx.ver || '?') + ', BroadcastChannel=' + !!chatChannel
                  + ', storage=' + ('localStorage' in window));
      // 按 roundId 取/建 live 气泡统一工厂（20260828o 提取）：
      // 本窗 sendMessage 预建（streaming=true 带 msg-streaming 流式 class）
      // 与远端 remoteLive 复用同一份 DOM 创建逻辑（原两份内联拷贝）
      const makeLiveBubble = (roundId, streaming) => {
        const div = document.createElement('div');
        div.className = 'chat-msg agent';
        const label = document.createElement('span');
        label.className = 'msg-label';
        label.textContent = '泠月喵: ';
        const content = document.createElement('span');
        content.className = 'msg-text';
        if (streaming) content.classList.add('msg-streaming'); // 流式纯文本阶段用 pre-line 换行
        div.appendChild(label);
        div.appendChild(content);
        messages.appendChild(div);
        const h = { el: div, contentSpan: content, processBox: null, finished: false };
        live[roundId] = h;
        return h;
      };
      // 按 roundId 取/建 live 气泡（远端帧专用；本窗流由 makeLiveBubble 预建）
      const remoteLive = (roundId) => live[roundId] || makeLiveBubble(roundId, false);
      window.addEventListener('storage', (e) => {
        // 其他标签页写本地历史 → 防抖 400ms 重放（DB 幂等收敛；游客走本地重放）。
        // 流式中只置 pendingPull，不打断当前渲染，流结束补拉。
        if (e.key && e.key.indexOf('chat_history_') === 0) {
          if (ctx.state.isSending || ctx.state.streamCtrl) { ctx.state.pendingPull = true; return; }
          clearTimeout(remotectlTimer);
          remotectlTimer = setTimeout(() => {
            if (!ctx.state.isSending && !ctx.state.streamCtrl) pullHistory();
          }, 400);
        }
      });
      if (chatChannel) {
        chatChannel.onmessage = (ev) => {
          const m = ev.data || {};
          try {
            if (m.t === 'user') {
              // 20260828s：跳过自己窗口广播的 user 帧（BroadcastChannel 回环——
              // 同 id 严格替换会把会话内 images 换成 hasImg 占位标记，图片丢失）
              if (m.from === windowId) return;
              // 远端用户消息：mergeItems 去重（同 id 严格替换/内容收养）+ 增量渲染。
              // 不写 localStorage（避免写者风暴），DB 拉取/收尾保存自然收敛。
              // 20260829a：广播带 images 跨窗传真图（用户要求其他窗口显示真图）；
              // hasImg 标记兜底（旧版广播/无图帧）→ 渲染占位块
              const item = __chatCore.migrateItem({
                id: m.id, type: 'user', text: m.text, time: m.time,
                ...(m.images && m.images.length ? { images: m.images } : {}),
                ...(m.hasImg ? { hasImg: 1 } : {}),
              });
              ctx.state.items = __chatCore.mergeItems(ctx.state.items, [item]);
              appendMsg(item);
              return;
            }
            if (!m.roundId) return;
            const h = remoteLive(m.roundId);
            if (m.t === 'token') {
              if (h.finished) return; // done/error 已到，丢弃乱序迟到帧
              // 20260828e：token 帧标记 msg-streaming（与本地 makeLiveBubble 一致）。
              // 远端气泡由 remoteLive 创建时无此 class，done 帧渲染条件①（流式 class）
              // 永不命中 → 正常回复（无命令污染、文本非空）保持纯文本不渲染 markdown
              // ——"其他窗口同步了记录但 markdown 没渲染"根因。加 class 后 done 帧
              // 条件命中必渲染；pull 先收养场景 class 已被移除 → 幂等跳过（无双注记）
              if (!h.contentSpan.classList.contains('msg-streaming')) {
                h.contentSpan.classList.add('msg-streaming');
              }
              // 20260828b 防御：远端不做命令分流，token 到达时按行剥离命令行
              // （旧版窗口广播原始 token / REVISE 拼接残留会带 AUTO_NAVIGATE 等，
              // 不剥离会显示在气泡里）；碎片命令由 done 帧含命令检测强制重渲染兜底
              const cleanToken = (m.text || '').split('\n')
                .map(l => {
                  if (!COMMAND_RE.test(l.trim())) return l;
                  const rest = stripCommandPrefix(l).trim();
                  return rest ? rest : null;
                })
                .filter(l => l !== null)
                .join('\n');
              if (!cleanToken) return;
              h.contentSpan.textContent += cleanToken;
              scrollToBottom(messages);
            } else if (m.t === 'process') {
              if (h.finished) return;
              if (!h.processBox) {
                h.processBox = makeProcessBox(!getCollapsePref());
                h.el.insertBefore(h.processBox, h.contentSpan);
              }
              const line = document.createElement('div');
              line.className = 'agent-process-line ' + (m.cls || 'step');
              line.textContent = m.text;
              h.processBox.querySelector('.agent-process-body').appendChild(line);
              const cnt = h.processBox.querySelector('.agent-process-count');
              if (cnt) cnt.textContent = '(' + h.processBox.querySelectorAll('.agent-process-line').length + ')';
            } else if (m.t === 'reset') {
              if (h.finished) return;
              h.contentSpan.textContent = '';
            } else if (m.t === 'done') {
              h.finished = true;
              // 空回复：无内容可转正（生产端同样不保存），直接移除气泡
              if (!m.fullText) {
                delete live[m.roundId];
                if (h.el.parentNode) h.el.parentNode.removeChild(h.el);
                return;
              }
              // 远端轮转正：mergeItems 进内存（同 id 严格替换，重复帧幂等）。
              // 已收敛（pull 先收养、mid 已设）→ 条目已在 items（'d' id），跳过
              // mergeItems 防止 'l' id 回写振荡（pull→'d'、done→'l' 来回换 id）
              if (!h.el.dataset.mid) {
                const item = __chatCore.migrateItem({ id: m.id, type: 'agent', text: m.fullText, time: m.time, process: m.process });
                ctx.state.items = __chatCore.mergeItems(ctx.state.items, [item]);
              }
              // 最终渲染幂等（applyMsg 为 innerHTML 替换）：reconcile 先收养渲染时
              // class 已移除且内容非空 → 跳过；纯 token 帧/空气泡 → 现场补渲染。
              // 渲染责任单一化：谁先到谁渲染，后到者只设标记（防双气泡/双注记）。
              // 20260828b：token 帧可能带命令污染（碎片剥离漏网）——内容含命令行时
              // 强制 clean 重渲染，保证 done 后气泡永不显示 AUTO_NAVIGATE 等命令文本
              const cs = h.contentSpan;
              if (cs.classList.contains('msg-streaming')
                  || (!cs.textContent && !cs.querySelector('.nav-skip-note'))
                  || COMMAND_RE.test(cs.textContent.trim())) {
                cs.classList.remove('msg-streaming');
                renderAgentContent(cs, m.fullText);
              }
              // 过程行补全（pull 收养先到时 processBox 未建，此处兜底）
              if (Array.isArray(m.process) && m.process.length && !h.processBox) {
                h.processBox = makeProcessBox(!getCollapsePref());
                const body = h.processBox.querySelector('.agent-process-body');
                m.process.forEach(p => {
                  const line = document.createElement('div');
                  line.className = 'agent-process-line ' + (p.cls || 'step');
                  line.textContent = p.text;
                  body.appendChild(line);
                });
                h.el.insertBefore(h.processBox, h.contentSpan);
              }
              h.el.dataset.mid = m.id;
              h.el.dataset.finished = '1';
              delete live[m.roundId];
              scrollToBottom(messages);
            } else if (m.t === 'error') {
              h.finished = true;
              h.el.dataset.finished = '1';
              applyMsg(h.contentSpan, m.msg);
              delete live[m.roundId];
            } else if (m.t === 'discard') {
              // 远端丢弃该轮：删句柄 + 删内存条目（用户消息 id 由 m.userItemId 指出）。
              // DB 侧由 Rust DiscardAbortedExchange 删，双侧一致。
              const victim = h.el;
              delete live[m.roundId];
              if (victim.parentNode) victim.parentNode.removeChild(victim);
              ctx.state.items = ctx.state.items.filter(i => i.id !== m.userItemId);
            }
          } catch(e) {/* 广播渲染失败不影响本页 */}
        };
      }
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
      // ── 历史存取：DB 权威（pullHistory），localStorage 仅离线/游客缓存 ──
      const historyKey = () => 'chat_history_' + (localStorage.getItem('tokenKey') || 'guest');
      const loadLocalHistory = () => {
        // 20260828a 起备份键退役：转跳恢复改由 DB 权威，游客走本地缓存（清理残留）
        try { sessionStorage.removeItem('chat_history_backup'); sessionStorage.removeItem('chat_history_backup_key'); } catch(e) {/* ignore */}
        try {
          const arr = JSON.parse(localStorage.getItem(historyKey()) || '[]');
          if (!Array.isArray(arr)) return [];
          // 20260828g：缓存是镜像（写入前已对齐），仅按 id 去重（旧版本可能残留
          // 重复条目），不再内容收养——镜像数据不需要启发式合并。
          // 旧格式条目无 id → migrateItem 补 id（写回随下次 saveHistory 落地）
          const seen = new Set();
          const out = [];
          for (const it of arr) {
            const m = __chatCore.migrateItem(it);
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            out.push(m);
          }
          return __chatCore.capItems(out, 50);
        } catch(e) { return []; }
      };
      // 唯一历史写者：序列化 → cap → 值与现值相同则跳过（变更检测终结多窗
      // 写→拉 ping-pong 与写者风暴；流式帧期间不被触发写）
      const saveHistory = () => {
        try {
          // 20260829a：本地缩略图方案——原图 dataURL 仍不落盘（单张可达 1MB × 6
          // 会撑爆 quota），但发送时异步生成的 180px 压缩缩略图（thumbs，每张
          // 几百字节~几 KB）落盘：刷新/重开窗口由 migrateItem 把 thumbs 恢复成
          // images 渲染真图，不再回退 [图片] 占位块（Rust DB 仍只有文本标记）。
          // 缩略图生成完成前的窗口期 / 旧缓存条目（无 thumbs）回退 hasImg 占位
          const forStorage = ctx.state.items.map(it => {
            if (it.images && it.images.length) {
              return Object.assign({}, it, { images: undefined,
                ...(it.thumbs && it.thumbs.length ? { thumbs: it.thumbs } : { hasImg: 1 }) });
            }
            return it;
          });
          const json = JSON.stringify(__chatCore.capItems(forStorage, 50));
          const key = historyKey();
          if (localStorage.getItem(key) === json) return;
          try {
            localStorage.setItem(key, json);
          } catch(e) {
            // QuotaExceeded 止损：裁剪到最近 30 条重试（逼近 5MB 上限时旧数据
            // 保留、新写入失败——曾现"转跳后新页面对话停在旧消息、新内容全丢"）
            const trimmed = JSON.stringify(__chatCore.capItems(forStorage, 30));
            if (localStorage.getItem(key) !== trimmed) {
              localStorage.setItem(key, trimmed);
              console.warn('[agent-chat] 历史超限，已裁剪到最近 30 条止损');
            }
          }
        } catch(e) {/* ignore */}
      };
      // DB 条目无 process（后端不存过程行）→ 按 (type,text) 从本地缓存富化。
      // 20260828e：匹配过 matchText——缓存 text 是收尾拼接（命令帧带 '\n'、
      // 分帧命令/正文间插入换行），DB content 是原始流式文本，逐字比较对导航轮
      // 全失配（"转跳后执行过程丢失"根因）。matchText 剥命令段 + 空白归一再比
      const lookupProcess = (text) => {
        try {
          const local = JSON.parse(localStorage.getItem(historyKey()) || '[]');
          if (!Array.isArray(local)) return undefined;
          const hit = local.find(i => i.type === 'agent' && __chatCore.matchText(i.text, text)
                                      && Array.isArray(i.process) && i.process.length);
          return hit ? hit.process : undefined;
        } catch(e) { return undefined; }
      };
      const applyLocal = () => {
        try {
          // 20260828g：本地兜底 = 缓存镜像整体替换（与 pull 同构，无合并启发式）。
          // 缓存是唯一镜像写者（saveHistory）产生的权威快照——拉取失败时它就是
          // 当时的最新视图，直接替换不会产生 'l'/'d' 混排。pull 成功后下次保存
          // 自动覆盖为服务器视图。
          ctx.state.items = loadLocalHistory();
          ctx.state.source = 'local';
          reconcileDOM();
        } catch(e) {
          console.error('[agent-chat] applyLocal 异常（不影响已渲染内容）:', e);
        }
      };
      // 主动停止时通知后端删除本轮（POST /api/chat/discard，20260828b）：用户点
      // "停止生成"= 明确不想要这条，DB 侧 user+残缺回复全删；连接中断（页面转跳/
      // 关标签）则由 Rust DiscardAbortedExchange 只删残缺、保留 user（消息已发出）。
      // 尽力而为：失败忽略（中断清理兜底只删残缺，下次拉取时用户消息仍在）
      const apiDiscard = () => {
        const tk = localStorage.getItem('tokenKey');
        if (!tk) return;
        fetch('/api/chat/discard', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + tk },
        }).catch(() => {});
      };
      // DB 权威拉取：无 token/失败 → 本地兜底；成功 → 服务器权威整体替换
      // （内存乐观 'l' 条目经 replaceWithIncoming 保留 60s 窗口）+ 增量渲染 +
      // 缓存同步（值变更检测防循环）
      const pullHistory = () => {
        if (ctx.state.isSending || ctx.state.streamCtrl) { ctx.state.pendingPull = true; return; } // 流式中永不重排
        const tk = localStorage.getItem('tokenKey');
        if (!tk) { applyLocal(); return; }
        // 8s 超时兜底：历史接口挂起时降级本地缓存（不阻塞面板打开）
        const pc = new AbortController();
        const pt = setTimeout(() => pc.abort(), 8000);
        fetch('/api/chat/history', {
          headers: { 'Authorization': 'Bearer ' + tk },
          credentials: 'same-origin',
          signal: pc.signal,
        }).then(r => (r.ok ? r.json() : null))
          .then(data => {
          if (!data || !Array.isArray(data.items)) { applyLocal(); return; }
          const incoming = data.items.map(it => __chatCore.migrateItem({
            id: 'd' + it.id,
            type: it.role === 'user' ? 'user' : 'agent',
            text: it.content,
            time: it.time,
            process: it.role === 'user' ? undefined : lookupProcess(it.content),
          }));
          // 20260828g：服务器权威——items 整体替换为 DB 视图，删除全部合并启发式。
          // 旧模型（mergeItems 并集 + 本地 'l' 条目混排）是乱序根源：本地条目
          // time 与服务器不一致、孤儿永不收敛、双窗结果恒不同。替换后所有窗拉
          // 同一份 incoming → 天然一致（写者风暴从机制上消失），缓存仅作镜像。
          // replaceWithIncoming 保留 60s 内未入库的 'l' 轮（DB 提交延迟窗口防闪烁）。
          ctx.state.items = __chatCore.replaceWithIncoming(ctx.state.items, incoming);
          ctx.state.source = 'db';
          // 20260828c：渲染与合并隔离——items 已是最新（DB 收敛），渲染失败
          // 不再整体降级本地缓存（旧版静默 catch → applyLocal 覆盖 items 导致
          // 旧记录连锁覆盖其他窗口）；下次面板打开/新条目到达自动补渲染
          try { reconcileDOM(); }
          catch(e) { console.error('[agent-chat] pullHistory 渲染异常（items 已更新，不降级）:', e); }
          saveHistory(); // 缓存同步（值变更检测防写者风暴）
        }).catch(e => { console.error('[agent-chat] pullHistory 拉取失败，本地缓存兜底:', e); applyLocal(); })
          .finally(() => { clearTimeout(pt); });
      };
      // ── 时间标签幂等维护（微信式时间分组）──
      // 标签是纯渲染物：不进 items、不序列化、不广播（items 权威同步后各窗本地
      // 收敛一致）。锚定关系：标签 = 所属消息气泡的紧邻前驱兄弟。
      // 调用方：appendMsg 末尾（新建/追加场景）+ reconcileDOM 循环（重排/收养场景）。
      const patchDivider = (el, item) => {
        const idx = ctx.state.items.indexOf(item);
        const prev = idx > 0 ? ctx.state.items[idx - 1] : null;
        const need = __chatCore.shouldShowTime(prev, item);
        let td = el.previousSibling && el.previousSibling.classList
              && el.previousSibling.classList.contains('chat-time-divider')
              ? el.previousSibling : null;
        if (need) {
          if (!td) {
            td = document.createElement('div');
            td.className = 'chat-time-divider';
            el.parentNode.insertBefore(td, el);
          }
          const text = __chatCore.formatTimeLabel(item.time);
          if (td.textContent !== text) td.textContent = text; // 防跨天显示过期文本
        } else if (td) {
          td.parentNode.removeChild(td);
        }
      };
      // 增量渲染：只追加缺失条目、不重绘已有（替代 messages.innerHTML='' 全量重建）。
      // 索引 byMid（已收尾元素带 data-mid）；在途轮元素（无 mid）经内容收养原位转正。
      const reconcileDOM = () => {
        const byMid = new Map();
        for (const child of messages.children) {
          if (child.dataset && child.dataset.mid) byMid.set(child.dataset.mid, child);
        }
        let lastEl = null;
        for (const item of ctx.state.items) {
          try {
            const mid = item.id || '';
            let el;
            if (byMid.has(mid)) {
              // 20260828f：位置修复——DOM 已有该气泡但顺序与 items 不一致时重排。
              // 旧逻辑无条件跳过（applyLocal 先渲染缓存、pull 后 byMid 命中永不
              // 修正）——风暴期缓存被打乱后错位气泡永久残留（"旧消息排最底"形态）。
              // 每次 reconcile 按 items 顺序校验相邻关系，错序时移动一次即自愈。
              el = byMid.get(mid);
            } else {
              // 内容碰撞收养（'l'→'d' id 换发 / pull 先于 done 收敛在途轮）：
              // 只收养未收敛元素（无 mid 或 'l' 前缀乐观 id）——已收敛的同内容元素
              // 不能收养，否则两条相同文本（如两次"你好"）会挤占同一气泡。
              // 20260828e：mtext 比较过 matchText（缓存/内存 text 与 DB content 的
              // 构造差异：命令帧 '\n'、分帧命令/正文间换行——剥命令段+归一后比）
              let adopted = null;
              for (const child of messages.children) {
                if (child.dataset && child.dataset.mtype === item.type
                    && __chatCore.matchText(child.dataset.mtext || '', item.text)
                    && (!child.dataset.mid || child.dataset.mid.startsWith('l'))) {
                  adopted = child; break;
                }
              }
              if (adopted) {
                adopted.dataset.mid = mid;
                adopted.dataset.finished = '1';
                // 在途轮被 pull 先收敛：live 句柄置 finished（拦截乱序迟到帧），
                // 保留句柄供 done 帧幂等收尾（delete 会造成 remoteLive 重建空气泡）
                for (const k in live) if (live[k].el === adopted) { live[k].finished = true; break; }
                // 流式纯文本/空气泡 → 补最终渲染（done 到达时条件不再满足，幂等跳过）
                const cs = adopted.querySelector('.msg-text');
                if (cs && (cs.classList.contains('msg-streaming')
                    || (!cs.textContent && !cs.querySelector('.nav-skip-note')))) {
                  cs.classList.remove('msg-streaming');
                  renderAgentContent(cs, item.text);
                }
                el = adopted;
              } else {
                el = appendMsg(item);
              }
            }
            // 时间标签幂等维护（appendMsg 新建的已内部 patch，重复调用无害）
            patchDivider(el, item);
            // 位置对齐（带标签整体移动）：期望 [td?, el] 紧邻且位于 lastEl 之后。
            // 标签是 el 的前驱兄弟不会跟着走——移动时须把 td 一起挪（20260828n）
            const td = el.previousSibling && el.previousSibling.classList
                     && el.previousSibling.classList.contains('chat-time-divider')
                     ? el.previousSibling : null;
            const ref = lastEl ? lastEl.nextSibling : messages.firstChild;
            if (!(td ? (td === ref && el === td.nextSibling) : (el === ref))) {
              if (td) messages.insertBefore(td, ref);
              messages.insertBefore(el, td ? td.nextSibling : ref);
            }
            lastEl = el;
          } catch(e) {
            // 20260828c：渲染隔离——单条渲染失败跳过该条，不中断整批
            // （旧 syncHistory 有同样隔离，20260828a 重构时丢失；单条抛错曾
            // 经 catch→applyLocal 把全部窗口覆盖成旧缓存）
            console.error('[agent-chat] 条目渲染失败已跳过:', item.id, e && e.message);
          }
        }
        // 20260828g：滑动窗口对齐——items 是权威视图，DOM 中不属于 items 的元素
        // 删除：① 带 mid 但不在 items（最老条目被挤出窗口 / 被放弃的轮）；② 无
        // mid 且非在途气泡（孤儿残留）。在途气泡（live 句柄）豁免——远端流式
        // 轮未收尾时不打断。删除在 items 循环之后执行：'l' 元素先经收养转正
        // （mid 换成 'd'）→ 转正成功的保留，真孤儿才被删。聊天软件式滑动窗口：
        // 新对话拉取后最早期记录自动覆盖。
        {
          const validMids = new Set();
          for (const it of ctx.state.items) validMids.add(it.id || '');
          const liveEls = new Set();
          for (const k in live) liveEls.add(live[k].el);
          for (const child of Array.from(messages.children)) {
            try {
              // 20260828n：时间标签豁免——标签无 mid 且非 live，但它是消息气泡的
              // 前导附属（由 patchDivider 幂等维护），不能当孤儿删
              if (child.classList && child.classList.contains('chat-time-divider')) continue;
              const mid = child.dataset && child.dataset.mid;
              let doomed = false;
              if (mid) doomed = !validMids.has(mid);
              else if (!liveEls.has(child)) doomed = true;
              if (doomed) {
                // 20260828o 修复：气泡删除时连带删除其前导时间标签——标签是气泡的
                // 锚定附属（patchDivider 只维护"紧邻前驱"，el 没了标签就悬空，
                // 会被后续 reconcile 的位置对齐当成下一个元素的标签捡走并覆盖文本
                // → 时间标签错位（实测：孤儿清理删断流转正轮后 TD 悬在错误位置）
                const td = child.previousSibling && child.previousSibling.classList
                        && child.previousSibling.classList.contains('chat-time-divider')
                        && child.previousSibling.nextSibling === child
                        ? child.previousSibling : null;
                if (td) messages.removeChild(td);
                messages.removeChild(child);
              }
            } catch(e) { /* 单元素删除失败不影响其余 */ }
          }
        }
        scrollToBottom(messages);
      };
      // 消息气泡工厂：DOM 创建 + dataset（mid/mtype/mtext 供 reconcile 索引与收养）
      // + 持久化（saveHistory 值变更检测）。调用方负责 items push。
      const appendMsg = (item) => {
        const div = document.createElement('div');
        div.className = 'chat-msg ' + item.type;
        div.dataset.mid = item.id || '';
        div.dataset.mtype = item.type;
        div.dataset.mtext = item.text;
        const label = document.createElement('span');
        label.className = 'msg-label';
        label.textContent = item.type === 'user' ? userLabel : '泠月喵: ';
        const content = document.createElement('span');
        content.className = 'msg-text';
        let box = null; // 20260828d：process 框在 label/content 挂载后统一插入（见下）
        if (item.type === 'user') {
          const bubble = document.createElement('span');
          bubble.className = 'msg-bubble';
          // 多模态（20260828 改进②，20260828s 多图，20260828t 渲染顺序修复）：
          // 气泡内直接展示图片——item.images 有 dataURL 数组逐张渲染（网格横排）；
          // 仅有 hasImg 标记（远端窗口广播）渲染占位块；刷新/DB 恢复无这两个字段
          // → 文本已含 [图片] 标记，原样显示。
          // ★ 顺序必须先 applyMsg 文本、后追加 grid/占位块：applyMsg 是
          // innerHTML 整体替换（chat-render.js），图片先 append 会被文本渲染
          // 覆盖删除——"气泡图片不显示"第三根因（渲染层），前两处修的是数据层
          // （广播回环/DB 回填），这里修的是 DOM 组装
          applyMsg(bubble, item.text);
          if (Array.isArray(item.images) && item.images.length) {
            const grid = document.createElement('div');
            grid.className = 'msg-img-grid';
            for (const src of item.images) {
              const im = document.createElement('img');
              im.className = 'msg-img';
              im.src = src;
              im.alt = '图片';
              grid.appendChild(im);
            }
            bubble.appendChild(grid);
          } else if (item.hasImg) {
            const ph = document.createElement('div');
            ph.className = 'msg-img-placeholder';
            ph.textContent = '🖼️ 图片';
            bubble.appendChild(ph);
          }
          content.appendChild(bubble);
        } else {
          // 命令型回复（纯 AUTO_NAVIGATE 等）恢复时兜底渲染灰色注记，不显示空气泡
          renderAgentContent(content, item.text);
          div.dataset.finished = '1';
          // 恢复该轮执行过程行（跨整页转跳保留，见保存端 process 字段）
          if (Array.isArray(item.process) && item.process.length) {
            box = makeProcessBox(!getCollapsePref());
            const body = box.querySelector('.agent-process-body');
            const cnt = box.querySelector('.agent-process-count');
            item.process.forEach(p => {
              const line = document.createElement('div');
              line.className = 'agent-process-line ' + (p.cls || 'step');
              line.textContent = p.text;
              body.appendChild(line);
            });
            if (cnt) cnt.textContent = '(' + item.process.length + ')';
          }
        }
        div.appendChild(label);
        div.appendChild(content);
        // 20260828d 修复：process 框在 label/content 挂载后再插入。旧代码在挂载前
        // 执行 div.insertBefore(box, content)——content 还不是 div 的子节点 →
        // TypeError → pullHistory 静默 catch → applyLocal 旧记录覆盖所有窗口
        // （"转跳后变成上次对话记录"根因，20260828c 日志暴露）
        if (box) div.insertBefore(box, content);
        messages.appendChild(div);
        // 20260828n：时间标签（微信式分组）——间隔大时在消息上方插标签。
        // 覆盖 sendMessage 乐观插入/远端 user 帧/done 转正/游客 notice 等
        // 全部非 reconcile 追加路径；reconcile 循环内新建的重复调用无害（幂等）。
        patchDivider(div, item);
        scrollToBottom(messages);
        // agent 消息触发嘴部动作（非流式/恢复场景）
        if (item.type === 'agent') {
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
                }, Math.min(1500, Math.max(300, item.text.length * 20)));
              }
            }
          } catch(e) {}
        }
        return div;
      };
      // 初始化：DB 权威拉取（游客/失败自动降级本地）
      pullHistory();

      // 导航跳转返回后：默认打开对话框并滚动到对话底部
      try {
        if (sessionStorage.getItem('chat_open')) {
          sessionStorage.removeItem('chat_open');
          chatPanel.classList.add('active');
          pullHistory(); // 同步其他页面产生的新对话
          setTimeout(() => scrollToBottom(messages, true), 60); // 转跳返回 = 看最新对话
        }
      } catch(e) {/* ignore */}
      // 20260828o：闭包函数挂到 api（init 是唯一填充点；autoload 在 init() 返回后
      // 才调 stream 工厂，此时 API 已齐备；#waifu 缺失重试路径下 stream.init 有
      // 独立面板存在检查等待，不会拿到半成品）
      api.scrollToBottom = scrollToBottom;
      api.broadcast = broadcast;
      api.pullHistory = pullHistory;
      api.saveHistory = saveHistory;
      api.apiDiscard = apiDiscard;
      api.windowId = windowId; // user 帧广播标记（onmessage 排除自己的广播回环）
      api.appendMsg = appendMsg;
      api.makeLiveBubble = makeLiveBubble;
      api.remoteLive = remoteLive;
      api.makeProcessBox = makeProcessBox;
      api.getCollapsePref = getCollapsePref;
      api.setCollapsePref = setCollapsePref;
    };
    api.init = init;
    return api;
  };
})(typeof window !== 'undefined' ? window : globalThis);
