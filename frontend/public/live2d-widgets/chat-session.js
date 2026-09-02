// ═ ChatSession：会话管理 UI 层（20260903 会话化一期）══
// 纯渲染与事件壳——决策全部在 chat-engine（会话三态/决议/切换原语/删除恢复），
// 本模块只做：列表拉取渲染、双栏开合与面板加宽、行点击切换、行内两步删除、
// 标题条渲染、rail 可见性评估。依赖 chat-engine 注入的 chatHTML 骨架
// （#chat-rail / #waifu-conv-panel / #conv-list / #chat-conv-title）。
// 游客（无 token）无会话概念：rail 整条隐藏，界面零变化（旧行为零回归）。
(function (g) {
  'use strict';
  g.__waifuSession = function (ctx, engine) {
    if (!ctx || !engine) {
      console.error('[chat-session] 缺少 ctx/engine——chat-engine 未加载或加载顺序错误');
      return null;
    }
    const CONV_WIDTH = 260; // 会话列表列宽（与 waifu.css --conv-w 一致）
    // 会话切换阻断：发送/流式中不切会话（收尾保存仍写原会话，见 chat-engine 注释）
    const switchBlocked = () => !!(ctx.state.isSending || ctx.state.streamCtrl
      || (ctx.state.remoteRounds && Object.keys(ctx.state.remoteRounds).length));
    const getToken = () => { try { return localStorage.getItem('tokenKey') || ''; } catch (e) { return ''; } };
    // 相对时间（列表行）：<1min 刚刚 · <60min N 分钟前 · 当日 N 小时前 ·
    // 年内 M-D · 跨年 Y-M-D（DB/日志时区 +08:00 本地钟面，前端时间戳同为本地）
    const relTime = (ms) => {
      const t = (typeof ms === 'number') ? ms : Date.now();
      const diff = Date.now() - t;
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
      const d = new Date(t), now = new Date();
      if (diff < 86400000 && d.getDate() === now.getDate()) return Math.floor(diff / 3600000) + ' 小时前';
      if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '-' + d.getDate();
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    };
    // 行标题：title NULL（未派生/纯图轮）显示"新对话"（产品拍板）
    const rowTitle = (c) => (c && c.title && String(c.title).trim()) ? String(c.title).trim() : '新对话';

    let chatPanel = null, convList = null, titleEl = null, rail = null;
    let _byId = new Map(); // conv id → 行数据（标题渲染查当前会话标题用）
    let listTimer = null;
    const scheduleFetch = () => { clearTimeout(listTimer); listTimer = setTimeout(fetchList, 120); };

    // ── 标题条：仅登录态且会话已决议（显式 id 或空白态）时显示，文本 = 当前会话
    // 标题（conv null + needCreate = 空白态 → "新对话"；auto 未决议不显示）──
    const currentTitle = () => {
      if (ctx.state.conv !== null) {
        const c = _byId.get(ctx.state.conv);
        return c ? rowTitle(c) : '';
      }
      if (ctx.state.convNeedCreate) return '新对话';
      return '';
    };
    const renderHeader = () => {
      if (!chatPanel || !titleEl) return;
      const tk = getToken();
      const show = !!tk && (ctx.state.conv !== null || ctx.state.convNeedCreate);
      chatPanel.classList.toggle('show-title', show);
      titleEl.textContent = show ? currentTitle() : '';
    };
    const highlight = () => {
      if (!convList) return;
      const cur = ctx.state.conv;
      for (const row of convList.children) {
        if (row.classList && row.classList.contains('conv-row')) {
          row.classList.toggle('active', cur !== null && String(row.dataset.id) === String(cur));
        }
      }
    };

    // ── 列表拉取（服务端 updated_at DESC 已排序）──
    const fetchList = async () => {
      if (!convList) return;
      const tk = getToken();
      if (!tk) { // 游客：无会话概念，空态提示（rail 已隐藏，仅防御路径可达）
        renderRows([]);
        renderHeader();
        return;
      }
      try {
        const r = await fetch('/api/chat/conversations', {
          headers: { 'Authorization': 'Bearer ' + tk },
          credentials: 'same-origin',
        });
        const j = r.ok ? await r.json().catch(() => null) : null;
        const list = (j && Array.isArray(j.conversations)) ? j.conversations : [];
        const rows = list.map(c => ({ id: c.id, title: c.title, updated_at: c.updated_at }));
        _byId = new Map(rows.map(c => [c.id, c]));
        // 列表外的会话缓存键清理（会话被删/过期列表外 → 镜像随删防膨胀）
        engine.pruneConvCaches(rows.map(c => c.id));
        renderRows(rows);
        renderHeader();
        highlight();
      } catch(e) { /* 网络错误保留旧列表（下次事件重拉） */ }
    };
    // 行内两步删除状态机（⋯ → 删除 → 确认删除 3s 过期还原；不用原生 confirm）
    const clearDel = () => {
      if (delTimer) { clearTimeout(delTimer); delTimer = null; }
      if (convList) {
        for (const row of convList.children) {
          if (row.classList) row.classList.remove('del-open', 'del-confirm');
        }
      }
    };
    let delTimer = null;
    const armConfirm = (row) => {
      row.classList.add('del-confirm');
      if (delTimer) clearTimeout(delTimer);
      delTimer = setTimeout(() => {
        delTimer = null;
        if (row.parentNode) row.classList.remove('del-open', 'del-confirm'); // 过期还原
      }, 3000);
    };
    const renderRows = (rows) => {
      convList.innerHTML = '';
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'conv-list-empty';
        empty.textContent = getToken() ? '还没有会话，点 ＋ 开始新对话' : '登录后可管理会话历史';
        convList.appendChild(empty);
        return;
      }
      for (const c of rows) {
        const row = document.createElement('div');
        row.className = 'conv-row';
        row.dataset.id = String(c.id);
        const t = document.createElement('span');
        t.className = 'conv-row-title';
        t.textContent = rowTitle(c);
        t.title = t.textContent; // 完整标题 tooltip（单行截断仍可读全）
        const time = document.createElement('span');
        time.className = 'conv-row-time';
        time.textContent = relTime(c.updated_at);
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'conv-more';
        more.textContent = '⋯';
        more.title = '更多操作';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'conv-row-del';
        delBtn.textContent = '删除';
        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'conv-row-del confirm';
        confirmBtn.textContent = '确认删除';
        row.appendChild(t);
        row.appendChild(time);
        row.appendChild(more);
        row.appendChild(delBtn);
        row.appendChild(confirmBtn);
        // ⋯：开/关删除态（del-open 时 ⋯ 隐藏、[删除] 显示）
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          if (row.classList.contains('del-open')) { row.classList.remove('del-open', 'del-confirm'); return; }
          clearDel();
          row.classList.add('del-open');
        });
        delBtn.addEventListener('click', (e) => { // [删除] → 红色[确认删除]（3s）
          e.stopPropagation();
          armConfirm(row);
        });
        confirmBtn.addEventListener('click', (e) => { // 确认 → 真删
          e.stopPropagation();
          doDelete(c.id);
        });
        // 行点击切会话；删除态下点行空白只收拢不切（防误触）
        row.addEventListener('click', () => {
          if (row.classList.contains('del-open')) { clearDel(); return; }
          switchTo(c.id);
        });
        convList.appendChild(row);
      }
    };
    const doDelete = async (id) => {
      const tk = getToken();
      if (!tk) return;
      const isCurrent = ctx.state.conv === id && !ctx.state.convNeedCreate;
      clearDel();
      if (isCurrent) {
        // 删当前会话：走引擎恢复流程（清 pref/会话态 → 无参回落最新会话或空态）
        engine.handleConvGone(id);
        return;
      }
      try {
        const r = await fetch('/api/chat/conversations/' + id, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + tk },
        });
        if (r.ok || r.status === 404) { // 404 = 已删（他端），本地同步移除
          const rowEl = convList.querySelector('.conv-row[data-id="' + id + '"]');
          if (rowEl && rowEl.parentNode) rowEl.parentNode.removeChild(rowEl);
          _byId.delete(id);
          engine.pruneConvCaches([..._byId.keys()]);
          fetchList(); // 收敛（防删除后行残留）
        } else {
          clearDel();
        }
      } catch(e) { clearDel(); }
    };

    // ── 会话切换 / 新对话（决策在 engine）──
    const switchTo = (id) => {
      if (switchBlocked()) return; // 流式中不切会话（收尾保存仍写原会话）
      if (ctx.state.conv === id && !ctx.state.convNeedCreate) { closeList(); return; }
      engine.adoptConversation(id); // 清旧视图 + 拉新会话 + 持久化（内部触发 onConvChange）
      closeList();
    };
    const startNew = () => {
      if (switchBlocked()) return;
      engine.adoptConversation(null); // 空白态：只清视图置 needCreate，不发无参拉取
      closeList();
      try { ctx.dom.input && ctx.dom.input.focus(); } catch(e) {/* ignore */}
    };

    // ── 双栏开合 + 面板加宽（几何：桌面 conv-open = 面板宽 +260，列表列 absolute
    // 260px 贴左；消息/输入区 margin-left 右移由 CSS 完成；移动端 ≤768px 面板宽度
    // 让位 CSS calc(100vw-30px)，列表覆盖式）──
    const isOpen = () => !!(chatPanel && chatPanel.classList.contains('conv-open'));
    const widenPanel = (delta) => {
      // 无 inline width 时先落成当前计算宽（加宽/收窄需要确定基准）
      const cur = chatPanel.offsetWidth || 300;
      chatPanel.style.width = Math.max(260, cur + delta) + 'px';
    };
    const openList = () => {
      if (isOpen()) return;
      chatPanel.classList.add('conv-open');
      if (window.innerWidth > 768) widenPanel(CONV_WIDTH); // 桌面：面板加宽出列表列
      fetchList();
    };
    const closeList = () => {
      if (!isOpen()) return;
      chatPanel.classList.remove('conv-open');
      if (window.innerWidth > 768) widenPanel(-CONV_WIDTH); // 收拢还原宽度
    };
    // 拖拽把手在 open 后拖动面板：宽度由 pointerdown 固定 offsetWidth（chat-stream），
    // 与本次加宽的 inline width 兼容；跨 768 断点 resize 修正宽度基准
    window.addEventListener('resize', () => {
      if (!isOpen()) return;
      if (window.innerWidth <= 768) { chatPanel.style.width = ''; return; } // CSS calc 接管
      widenPanel(0); // 落桌面：固定当前计算宽，防后续 open/close 基准漂移
    });
    const toggleList = () => (isOpen() ? closeList() : openList());

    // ── rail 可见性评估（游客无会话概念 → 整条隐藏，零回归）──
    const evalAuth = () => {
      if (rail) rail.style.display = getToken() ? '' : 'none';
      if (!getToken() && isOpen()) closeList();
    };
    const evalTitleOnConvChange = () => { renderHeader(); highlight(); scheduleFetch(); };

    const init = () => {
      const p = document.getElementById('waifu-chat');
      const list = document.getElementById('conv-list');
      if (!p || !list) { setTimeout(init, 500); return; } // engine 注入 chatHTML 在前
      chatPanel = p;
      convList = list;
      titleEl = document.getElementById('chat-conv-title');
      rail = document.getElementById('chat-rail');
      const bind = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
      };
      bind('conv-toggle-btn', toggleList);   // ☰ 展开/收起列表
      bind('conv-history-btn', openList);    // 历 打开历史
      bind('conv-new-btn', startNew);        // ＋ 新对话
      bind('conv-head-new-btn', startNew);   // ✚ 新对话（列表头部）
      bind('conv-collapse-btn', closeList);  // ⟵ 收起列表
      // 钩子注册：引擎做决策（onConvChange 等都在引擎的会话态变化点调用），
      // UI 只响应渲染/拉取。全部 try 包裹（引擎侧调用时已 try，此处再兜底）
      engine.setConvUI({
        onConvChange: evalTitleOnConvChange,   // 决议/采纳/空白态切换
        onConvGone: () => { scheduleFetch(); renderHeader(); }, // 404 恢复后回落已由引擎拉取
        onAuthChange: () => { evalAuth(); _byId = new Map(); renderRows([]); scheduleFetch(); },
        onListDirty: scheduleFetch,            // 每轮收尾（标题派生/touch 在服务端）
      });
      evalAuth();
      fetchList();
      // 会话列表开启中收到跨窗新数据（notifyListDirty 防抖 120ms），关闭面板时
      // 打开瞬间总会 fetchList 一次，无需额外监听
    };

    return { init };
  };
})(typeof window !== 'undefined' ? window : globalThis);
