// ═ ChatSession：会话管理 UI 层（20260903 会话化一期；20260903b 布局重构）══
// 纯渲染与事件壳——决策全部在 chat-engine（会话三态/决议/切换原语/删除恢复），
// 本模块只做：列表拉取渲染、自适应抽屉开合、行内菜单（删除/置顶/重命名）、
// 搜索过滤、rail 图标注入、当前会话标题（顶拖拽条内）。依赖 chat-engine 注入的
// chatHTML 骨架（#chat-rail / #waifu-conv-panel / #conv-list / #chat-conv-title）。
//
// 20260903b 几何（用户拍板）：
// - 抽屉宽 CONV_WIDTH=182（waifu.css --conv-w，收窄 30%）
// - rail（侧边栏）固定面板最左不动；☰ 顶、＋/历 底组（靠图片按钮往上堆叠）
// - conv-open 面板宽度/消息区零位移；抽屉自适应：面板左缘到视口 ≥ 182+12 →
//   conv-out 向左弹出（面板外），否则 conv-in 面板内覆盖（移动端恒 conv-in）
// - 会话标题不占消息区：写入顶拖拽条内 #chat-conv-title（非空才可见）
// - 列表头：标题 + 搜索框（本地过滤行标题）；行 ⋯ → 菜单[删除/置顶/重命名]，
//   点非列表区域自动收起
// 游客（无 token）无会话概念：rail 整条隐藏，界面零变化（旧行为零回归）。
(function (g) {
  'use strict';
  g.__waifuSession = function (ctx, engine) {
    if (!ctx || !engine) {
      console.error('[chat-session] 缺少 ctx/engine——chat-engine 未加载或加载顺序错误');
      return null;
    }
    const CONV_WIDTH = 182; // 抽屉列宽（与 waifu.css --conv-w 一致，用户收窄 30%）
    const DRAWER_OFFSET = 12; // conv-out 判定：面板左缘离视口左边的最小间距
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

    // ── rail 图标（用户提供 SVG，20260903b 起注入；文字为注入前兜底）──
    const ICON_SIDEBAR = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M810.666667 85.333333a128 128 0 0 1 128 128v597.333334a128 128 0 0 1-128 128H213.333333a128 128 0 0 1-128-128V213.333333a128 128 0 0 1 128-128h597.333334zM341.333333 170.666667H213.333333l-5.802666 0.426666a42.538667 42.538667 0 0 0-36.48 36.437334L170.666667 213.333333v597.333334l0.426666 5.802666a42.538667 42.538667 0 0 0 36.437334 36.48L213.333333 853.333333h128V170.666667z m469.333334 0h-384v682.666666h384l5.802666-0.426666a42.538667 42.538667 0 0 0 36.48-36.437334L853.333333 810.666667V213.333333l-0.426666-5.802666A42.538667 42.538667 0 0 0 810.666667 170.666667z" fill="#666666"/></svg>';
    const ICON_NEW = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M938.666667 469.333333c-23.608889 0-42.666667 19.057778-42.666667 42.666667v85.333333c0 70.542222-57.457778 128-128 128h-149.333333c-11.377778 0-22.186667 4.551111-30.151111 12.515556L512 814.364444l-76.515556-76.515555c-7.964444-7.964444-18.773333-12.515556-30.151111-12.515556H256c-70.542222 0-128-57.457778-128-128V298.666667C128 228.124444 185.457778 170.666667 256 170.666667h341.333333c23.608889 0 42.666667-19.057778 42.666667-42.666667S620.942222 85.333333 597.333333 85.333333H256c-117.76 0-213.333333 95.573333-213.333333 213.333334V597.333333c0 117.76 95.573333 213.333333 213.333333 213.333334h131.697778l94.151111 94.151111c8.248889 8.248889 19.342222 12.515556 30.151111 12.515555s21.902222-4.266667 30.151111-12.515555l94.151111-94.151111H768c117.76 0 213.333333-95.573333 213.333333-213.333334v-85.333333c0-23.608889-19.057778-42.666667-42.666666-42.666667z" fill="#203042"/><path d="M967.111111 213.333333h-71.111111V142.222222c0-23.608889-19.057778-42.666667-42.666667-42.666666s-42.666667 19.057778-42.666666 42.666666v71.111111H739.555556c-23.608889 0-42.666667 19.057778-42.666667 42.666667s19.057778 42.666667 42.666667 42.666667h71.111111V369.777778c0 23.608889 19.057778 42.666667 42.666666 42.666666s42.666667-19.057778 42.666667-42.666666v-71.111111H967.111111c23.608889 0 42.666667-19.057778 42.666667-42.666667s-19.057778-42.666667-42.666667-42.666667z" fill="#203042"/></svg>';
    const ICON_HISTORY = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M469.333333 554.666667l128 128 59.733334-59.733334-102.4-102.4V341.333333h-85.333334v213.333334zM85.333333 256l149.333334 149.333333 29.866666 29.866667C298.666667 332.8 396.8 256 512 256c140.8 0 256 115.2 256 256s-115.2 256-256 256c-128 0-234.666667-93.866667-251.733333-217.6l-85.333334-85.333333c-4.266667 17.066667-4.266667 29.866667-4.266666 46.933333 0 187.733333 153.6 341.333333 341.333333 341.333333s341.333333-153.6 341.333333-341.333333-153.6-341.333333-341.333333-341.333333C405.333333 170.666667 311.466667 221.866667 247.466667 298.666667l-42.666667-42.666667H85.333333z" fill="#444444"/></svg>';

    let chatPanel = null, convList = null, drawer = null, titleEl = null, rail = null, searchEl = null;
    let _rows = []; // 服务端全量（排序权威：pinned 优先 + updated_at DESC）
    let _byId = new Map(); // conv id → 行数据（标题渲染查当前会话标题用）
    let query = ''; // 搜索词（trim + lowercase），空 = 不过滤
    let listTimer = null, searchTimer = null, delTimer = null;
    const scheduleFetch = () => { clearTimeout(listTimer); listTimer = setTimeout(fetchList, 120); };

    // ── 顶拖拽条内标题：仅登录且会话已决议（显式 id 或空白态）时显示文本；
    // 空文本即隐藏（CSS :empty）。conv null + needCreate = 空白态 → "新对话" ──
    const currentTitle = () => {
      if (ctx.state.conv !== null) {
        const c = _byId.get(ctx.state.conv);
        return c ? rowTitle(c) : '';
      }
      if (ctx.state.convNeedCreate) return '新对话';
      return '';
    };
    const renderHeader = () => {
      if (!titleEl) return;
      const tk = getToken();
      titleEl.textContent = (tk && (ctx.state.conv !== null || ctx.state.convNeedCreate)) ? currentTitle() : '';
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

    // ── 菜单/编辑态清理（⋯ 菜单、删除确认、重命名）──
    const clearMenuAll = () => {
      if (delTimer) { clearTimeout(delTimer); delTimer = null; }
      if (convList) {
        for (const row of convList.children) {
          if (row.classList) row.classList.remove('menu-open', 'del-confirm', 'renaming');
        }
      }
    };

    // ── 列表拉取（服务端排序权威：置顶在前 + updated_at DESC）──
    const filterRows = () => {
      if (!query) return _rows;
      return _rows.filter(c => rowTitle(c).toLowerCase().indexOf(query) !== -1);
    };
    const fetchList = async () => {
      if (!convList) return;
      const tk = getToken();
      if (!tk) { // 游客：无会话概念，空态提示（rail 已隐藏，仅防御路径可达）
        _rows = [];
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
        _rows = list.map(c => ({ id: c.id, title: c.title, updated_at: c.updated_at, pinned: !!c.pinned }));
        _byId = new Map(_rows.map(c => [c.id, c]));
        // 列表外的会话缓存键清理（会话被删/过期列表外 → 镜像随删防膨胀）
        engine.pruneConvCaches(_rows.map(c => c.id));
        renderRows(filterRows());
        renderHeader();
        highlight();
      } catch(e) { /* 网络错误保留旧列表（下次事件重拉） */ }
    };

    // ── PATCH（置顶/重命名）：成功 → 重拉列表（服务端重排） + 刷标题 ──
    const apiPatch = async (id, body) => {
      const tk = getToken();
      if (!tk) return false;
      try {
        const r = await fetch('/api/chat/conversations/' + id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tk },
          body: JSON.stringify(body),
        });
        if (!r.ok) { console.warn('[chat-session] 会话更新失败', r.status); return false; }
        fetchList();
        renderHeader();
        return true;
      } catch(e) { return false; }
    };

    // ── 删除两步确认（⋯ → 菜单删除 → 行变红色确认条 3s 过期还原；不用原生 confirm）
    const armDelete = (row) => {
      row.classList.remove('menu-open');
      row.classList.add('del-confirm');
      if (delTimer) clearTimeout(delTimer);
      delTimer = setTimeout(() => {
        delTimer = null;
        if (row.parentNode) row.classList.remove('del-confirm');
      }, 3000);
    };
    const doDelete = async (id) => {
      const tk = getToken();
      if (!tk) return;
      const isCurrent = ctx.state.conv === id && !ctx.state.convNeedCreate;
      clearMenuAll();
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
          _rows = _rows.filter(c => c.id !== id);
          engine.pruneConvCaches(_rows.map(c => c.id));
          fetchList(); // 收敛（防删除后行残留）
        } else {
          clearMenuAll();
        }
      } catch(e) { clearMenuAll(); }
    };

    // ── 置顶（PATCH pinned；成功重拉列表 → 服务端置顶重排）──
    const togglePin = async (row, c) => {
      clearMenuAll();
      await apiPatch(c.id, { pinned: !c.pinned });
    };

    // ── 重命名（行内输入框；Enter/失焦保存，Esc 取消）──
    const startRename = (row, c) => {
      clearMenuAll();
      const orig = (c.title && String(c.title).trim()) || ''; // 原名（null = 未派生）
      row.classList.add('renaming');
      const titleSpan = row.querySelector('.conv-row-title');
      if (!titleSpan) { row.classList.remove('renaming'); return; }
      titleSpan.style.display = 'none';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'conv-rename-input';
      inp.maxLength = 64;
      inp.value = orig;
      inp.title = '回车保存 · Esc 取消';
      titleSpan.parentNode.insertBefore(inp, titleSpan);
      inp.focus();
      inp.select();
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        const val = inp.value.trim();
        row.classList.remove('renaming');
        titleSpan.style.display = '';
        if (inp.parentNode) inp.parentNode.removeChild(inp);
        if (save && val && val !== orig) apiPatch(c.id, { title: val }); // 空/未改 → 还原
      };
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        else if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); }
      });
      inp.addEventListener('blur', () => finish(true));
    };

    // ── 行渲染：标题（截断+置顶标）+ 相对时间 + ⋯（菜单）＋ 删除确认条 ──
    const renderRows = (rows) => {
      convList.innerHTML = '';
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'conv-list-empty';
        empty.textContent = query
          ? '没有匹配的会话'
          : (getToken() ? '还没有会话，点 ＋ 开始新对话' : '登录后可管理会话历史');
        convList.appendChild(empty);
        return;
      }
      for (const c of rows) {
        const row = document.createElement('div');
        row.className = 'conv-row' + (c.pinned ? ' pinned' : '');
        row.dataset.id = String(c.id);
        const main = document.createElement('div');
        main.className = 'conv-row-main';
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
        // 纵向菜单：删除（危险）/ 置顶切换 / 重命名
        const menu = document.createElement('div');
        menu.className = 'conv-row-menu';
        const mk = (label, cls, fn) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'conv-menu-item' + (cls ? ' ' + cls : '');
          b.textContent = label;
          b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
          return b;
        };
        menu.appendChild(mk('删除', 'danger', () => armDelete(row)));
        menu.appendChild(mk(c.pinned ? '取消置顶' : '置顶', '', () => togglePin(row, c)));
        menu.appendChild(mk('重命名', '', () => startRename(row, c)));
        main.appendChild(t);
        main.appendChild(time);
        main.appendChild(more);
        main.appendChild(menu);
        // 删除确认条（armDelete 后覆盖行内容，3s 过期还原）
        const confirm = document.createElement('div');
        confirm.className = 'conv-row-confirm';
        confirm.textContent = '确认删除该会话？';
        confirm.addEventListener('click', (e) => {
          e.stopPropagation();
          if (delTimer) { clearTimeout(delTimer); delTimer = null; }
          doDelete(c.id);
        });
        row.appendChild(main);
        row.appendChild(confirm);
        // ⋯：开/关菜单（点行空白/非列表区自动收起）
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          if (row.classList.contains('menu-open')) { clearMenuAll(); return; }
          clearMenuAll();
          row.classList.add('menu-open');
          // 列表下部行：菜单改向上弹（防溢出被滚动区裁切）
          const body = convList;
          if (body) {
            const up = row.offsetTop + row.offsetHeight + 96 > body.clientHeight + body.scrollTop;
            row.classList.toggle('menu-up', up);
          }
        });
        row.addEventListener('click', () => {
          if (row.classList.contains('renaming')) return; // 提交/取消由 input 处理
          if (row.classList.contains('del-confirm') || row.classList.contains('menu-open')) {
            clearMenuAll();
            return;
          }
          switchTo(c.id);
        });
        convList.appendChild(row);
      }
    };

    // ── 会话切换 / 新对话（决策在 engine）──
    const switchTo = (id) => {
      if (switchBlocked()) return; // 流式中不切会话（收尾保存仍写原会话）
      clearMenuAll();
      if (ctx.state.conv === id && !ctx.state.convNeedCreate) { closeList(); return; }
      engine.adoptConversation(id); // 清旧视图 + 拉新会话 + 持久化（内部触发 onConvChange）
      closeList();
    };
    const startNew = () => {
      if (switchBlocked()) return;
      clearMenuAll();
      engine.adoptConversation(null); // 空白态：只清视图置 needCreate，不发无参拉取
      closeList();
      try { ctx.dom.input && ctx.dom.input.focus(); } catch(e) {/* ignore */}
    };

    // ── 抽屉开合（自适应方向）：面板宽/消息区零位移；抽屉为叠层 ──
    // conv-out：面板左缘距视口左边 ≥ 182+12 → 抽屉在面板左缘外向左弹出
    // conv-in（默认）：抽屉从 rail 右缘（x=24）起覆盖消息区左段；移动端恒 conv-in
    const isOpen = () => !!(chatPanel && chatPanel.classList.contains('conv-open'));
    const openList = () => {
      if (isOpen()) return;
      chatPanel.classList.add('conv-open');
      if (window.innerWidth > 768) {
        const rect = chatPanel.getBoundingClientRect();
        if (rect.left >= CONV_WIDTH + DRAWER_OFFSET) chatPanel.classList.add('conv-out');
        else chatPanel.classList.add('conv-in');
      } else {
        chatPanel.classList.add('conv-in'); // 移动端恒面板内覆盖
      }
      fetchList();
    };
    const closeList = () => {
      if (!isOpen()) return;
      chatPanel.classList.remove('conv-open', 'conv-in', 'conv-out');
    };
    const toggleList = () => (isOpen() ? closeList() : openList());
    // 面板被拖走/窗口改尺寸后旧方向可能失效（抽屉出屏）→ 一律收起（下次打开重估）
    window.addEventListener('resize', closeList);

    // ── rail 可见性评估（游客无会话概念 → 整条隐藏，零回归）──
    const evalAuth = () => {
      if (rail) rail.style.display = getToken() ? '' : 'none';
      if (!getToken() && isOpen()) closeList();
    };
    const evalTitleOnConvChange = () => { renderHeader(); highlight(); scheduleFetch(); };

    // 点击非列表区域自动收起（菜单 + 抽屉）：
    // 面板外 → 收抽屉；面板内非抽屉/非 rail（消息区/输入区/标题条）→ 收抽屉
    const onDocDown = (e) => {
      if (!chatPanel || !isOpen()) { if (chatPanel) clearMenuAll(); return; }
      const t = e.target;
      if (!chatPanel.contains(t)) { closeList(); clearMenuAll(); return; }
      if ((drawer && drawer.contains(t)) || (rail && rail.contains(t))) return;
      closeList();
      clearMenuAll();
    };

    const init = () => {
      const p = document.getElementById('waifu-chat');
      const list = document.getElementById('conv-list');
      if (!p || !list) { setTimeout(init, 500); return; } // engine 注入 chatHTML 在前
      chatPanel = p;
      convList = list;
      drawer = document.getElementById('waifu-conv-panel');
      titleEl = document.getElementById('chat-conv-title');
      rail = document.getElementById('chat-rail');
      searchEl = document.getElementById('conv-search');
      // rail 图标注入（文字兜底在注入前瞬间可见，可忽略）
      const icons = { 'conv-toggle-btn': ICON_SIDEBAR, 'conv-new-btn': ICON_NEW, 'conv-history-btn': ICON_HISTORY };
      for (const id in icons) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = icons[id];
      }
      const bind = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
      };
      bind('conv-toggle-btn', toggleList);   // 侧边栏：展开/收起抽屉
      bind('conv-new-btn', startNew);        // ＋ 新对话
      bind('conv-history-btn', openList);    // 历史：打开抽屉
      if (searchEl) {
        searchEl.addEventListener('input', () => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => {
            query = searchEl.value.trim().toLowerCase();
            renderRows(filterRows());
            highlight();
          }, 120);
        });
        searchEl.addEventListener('keydown', (ev) => {
          if (ev.key === 'Escape') { ev.stopPropagation(); searchEl.blur(); }
        });
      }
      document.addEventListener('mousedown', onDocDown);
      // 钩子注册：引擎做决策（onConvChange 等都在引擎的会话态变化点调用），
      // UI 只响应渲染/拉取。全部 try 包裹（引擎侧调用时已 try，此处再兜底）
      engine.setConvUI({
        onConvChange: evalTitleOnConvChange,   // 决议/采纳/空白态切换
        onConvGone: () => { scheduleFetch(); renderHeader(); }, // 404 恢复后回落已由引擎拉取
        onAuthChange: () => { evalAuth(); _rows = []; _byId = new Map(); query = ''; if (searchEl) searchEl.value = ''; renderRows([]); scheduleFetch(); },
        onListDirty: scheduleFetch,            // 每轮收尾（标题派生/touch 在服务端）
      });
      evalAuth();
      fetchList();
    };

    return { init };
  };
})(typeof window !== 'undefined' ? window : globalThis);
