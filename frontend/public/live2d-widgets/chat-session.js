// ═ ChatSession：会话管理 UI 层（20260903 会话化一期；20260903b 布局重构）══
// 纯渲染与事件壳——决策全部在 chat-engine（会话三态/决议/切换原语/删除恢复），
// 本模块只做：列表拉取渲染、自适应抽屉开合、行内菜单（删除/置顶/重命名）、
// 搜索过滤、rail 图标注入、当前会话标题（顶拖拽条内）。依赖 chat-engine 注入的
// chatHTML 骨架（#chat-rail / #waifu-conv-panel / #conv-list / #chat-conv-title）。
//
// 20260903c 几何（用户第二轮实测拍板）：
// - 抽屉宽 CONV_WIDTH=182（waifu.css --conv-w，收窄 30%）
// - rail（侧边栏）固定面板最左不动；☰ 顶、＋/历 底组（靠图片按钮往上堆叠）
// - 展开语义 = "拖拽栏不动，向左开拓出侧边栏区域"：conv-out（空间足够）面板
//   整体左移+加宽 182（JS 管几何），CSS 把内部布局右移 182 → 消息区/拖拽栏
//   视口位置不变，左 182 列成为会话侧边栏真窗格（不再是叠层）；
//   conv-in（面板左缘距视口 <186px / 移动端）：rail 右缘起面板内覆盖兜底。
//   开合快照即时逆推（close 由当前几何 -182），拖动/缩放中途开合不失真
// - 会话标题不占消息区：写入顶拖拽条内 #chat-conv-title（非空才可见）
// - 列表头：标题 + 搜索框（本地过滤行标题）；行 ⋯ → 纵向菜单默认向下展开
//   （仅贴列表底会溢出下缘时翻上；旧 offsetTop 含列表头高度的判据已废——
//   顶部行的菜单曾整体飞出被裁切）
// - 行菜单：删除 / 加入书签|删除书签（置顶切换）/ 重命名，均带用户 SVG 图标；
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
    const CONV_GAP = 4; // 左扩可行判据：面板左扩 182 后左缘距视口仍 ≥4px
    // → rect.left ≥ CONV_WIDTH + CONV_GAP 才置 conv-out，否则 conv-in 覆盖兜底
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
    // ── 行菜单图标（用户提供，20260903c 注入；尺寸由 CSS .conv-menu-item svg 控制）──
    const ICON_PIN = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M736 288H288a32 32 0 1 1 0-64h448a32 32 0 0 1 0 64z m-32 512a32 32 0 0 1-22.72-9.28L512 621.44l-169.28 169.28A32 32 0 0 1 288 768V384a32 32 0 0 1 32-32h384a32 32 0 0 1 32 32v384a32 32 0 0 1-32 32z m-192-256a32 32 0 0 1 22.72 9.28L672 690.56V416H352v274.88l137.28-137.28A32 32 0 0 1 512 544z" fill="#202425"/></svg>'; // 加入书签
    const ICON_UNPIN = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M468.394667 106.666667a42.666667 42.666667 0 0 1 3.2 85.226666l-3.2 0.106667H234.666667v641.237333l252.885333-185.002666a42.666667 42.666667 0 0 1 47.402667-2.005334l3.072 2.069334L789.333333 833.024V577.045333a42.666667 42.666667 0 0 1 39.466667-42.538666l3.2-0.128a42.666667 42.666667 0 0 1 42.56 39.488l0.106667 3.2V917.333333c0 33.877333-37.333333 53.824-65.28 36.202667l-2.666667-1.834667L512.682667 735.573333 217.194667 951.765333c-27.306667 19.989333-65.386667 1.706667-67.754667-31.210666L149.333333 917.333333V149.333333a42.666667 42.666667 0 0 1 39.466667-42.56L192 106.666667h276.394667zM746.666667 64c117.824 0 213.333333 95.509333 213.333333 213.333333s-95.509333 213.333333-213.333333 213.333334-213.333333-95.509333-213.333334-213.333334S628.842667 64 746.666667 64z m0 85.333333a128 128 0 1 0 0 256 128 128 0 0 0 0-256z m32 96a32 32 0 0 1 0 64h-64a32 32 0 0 1 0-64h64z" fill="#333333"/></svg>'; // 删除书签
    const ICON_DELETE = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path d="M799.2 874.4c0 34.4-28.001 62.4-62.4 62.4H287.2c-34.4 0-62.4-28-62.4-62.4V212h574.4v662.4zM349.6 100c0-7.2 5.6-12.8 12.8-12.8h300c7.2 0 12.8 5.6 12.8 12.8v37.6H349.6V100z m636.8 37.6H749.6V100c0-48.001-39.2-87.2-87.2-87.2h-300c-48 0-87.2 39.199-87.2 87.2v37.6H37.6C16.8 137.6 0 154.4 0 175.2s16.8 37.6 37.6 37.6h112v661.6c0 76 61.6 137.6 137.6 137.6h449.6c76 0 137.6-61.6 137.6-137.6V212h112c20.8 0 37.6-16.8 37.6-37.6s-16.8-36.8-37.6-36.8zM512 824c20.8 0 37.6-16.8 37.6-37.6v-400c0-20.8-16.8-37.6-37.6-37.6s-37.6 16.8-37.6 37.6v400c0 20.8 16.8 37.6 37.6 37.6m-175.2 0c20.8 0 37.6-16.8 37.6-37.6v-400c0-20.8-16.8-37.6-37.6-37.6s-37.6 16.8-37.6 37.6v400c0.8 20.8 17.6 37.6 37.6 37.6m350.4 0c20.8 0 37.6-16.8 37.6-37.6v-400c0-20.8-16.8-37.6-37.6-37.6s-37.6 16.8-37.6 37.6v400c0 20.8 16.8 37.6 37.6 37.6" fill="#8A8A8A"/></svg>'; // 删除
    const ICON_RENAME = ICON_SIDEBAR; // 重命名：用户指定同款双矩形图标（t=1788375596665，与侧边栏按钮同源）

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
        // 纵向菜单：删除（危险）/ 加入书签|删除书签（置顶切换）/ 重命名（图标+文字）
        const menu = document.createElement('div');
        menu.className = 'conv-row-menu';
        const mk = (label, icon, cls, fn) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'conv-menu-item' + (cls ? ' ' + cls : '');
          b.innerHTML = icon + '<span>' + label + '</span>';
          b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
          return b;
        };
        menu.appendChild(mk('删除', ICON_DELETE, 'danger', () => armDelete(row)));
        menu.appendChild(mk(c.pinned ? '删除书签' : '加入书签', c.pinned ? ICON_UNPIN : ICON_PIN, '', () => togglePin(row, c)));
        menu.appendChild(mk('重命名', ICON_RENAME, '', () => startRename(row, c)));
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
        // ⋯：开/关菜单（点行空白/非列表区自动收起）。方向默认从行当前位置
        // 向下展开；仅当菜单会溢出列表下缘（被 conv-list-body overflow-y 裁切）
        // 才向上翻。判据按列表内容区折算：row.offsetTop 的基准是面板（含列表头
        // 高度），须减 body.offsetTop；滚动后 offsetTop 不变、scrollTop 补偿，
        // 等价"可见窗口"判定——顶部行不再误判向上（旧判据的经典 bug）
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          if (row.classList.contains('menu-open')) { clearMenuAll(); return; }
          clearMenuAll();
          row.classList.add('menu-open');
          const body = convList;
          if (body) {
            const menuH = menu.offsetHeight || 100; // 显示后同帧度量（无绘制间隙）
            const rowTopInBody = row.offsetTop - body.offsetTop;
            const up = rowTopInBody + row.offsetHeight + menuH > body.clientHeight + body.scrollTop;
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

    // ── 抽屉开合（20260903c 用户拍板）：拖拽栏/消息区视口不动，向左开拓出 ──
    // conv-out（空间足够）：面板整体左移 CONV_WIDTH + 加宽 CONV_WIDTH（几何由
    //   JS 保证），CSS 同步把内部布局右移 var(--conv-w) → 消息区/rail/拖拽栏
    //   视口位置零位移，左侧 182 列成为会话侧边栏真窗格（不再是面板外叠层——
    //   旧实现被 #waifu-chat overflow:hidden 裁切，屏幕中段直接打不开）。
    //   关闭还原用"当前几何逆推 -182"（close 时读数，不依赖打开快照）——
    //   展开期间拖动/缩放窗口也不失真。
    // conv-in（左缘贴边 rect.left <186px / 移动端）：抽屉从 rail 右缘（x=24）
    //   起覆盖消息区左段兜底；conv-out 面板左扩不得把窗口推出屏外。
    const isOpen = () => !!(chatPanel && chatPanel.classList.contains('conv-open'));
    const openList = () => {
      if (isOpen()) return;
      chatPanel.classList.add('conv-open');
      if (window.innerWidth > 768) {
        const rect = chatPanel.getBoundingClientRect();
        if (rect.left >= CONV_WIDTH + CONV_GAP) {
          chatPanel.style.left = (chatPanel.offsetLeft - CONV_WIDTH) + 'px'; // #waifu 内坐标
          chatPanel.style.width = (chatPanel.offsetWidth + CONV_WIDTH) + 'px';
          chatPanel.classList.add('conv-out');
        } else {
          chatPanel.classList.add('conv-in');
        }
      } else {
        chatPanel.classList.add('conv-in'); // 移动端恒面板内覆盖
      }
      fetchList();
    };
    const closeList = () => {
      if (!isOpen()) return;
      const wasOut = chatPanel.classList.contains('conv-out');
      chatPanel.classList.remove('conv-open', 'conv-in', 'conv-out');
      if (wasOut) { // 左扩还原：由当前几何逆推（期间拖动/缩放不丢位移）
        chatPanel.style.left = (chatPanel.offsetLeft + CONV_WIDTH) + 'px';
        chatPanel.style.width = (chatPanel.offsetWidth - CONV_WIDTH) + 'px';
      }
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
      // 拖拽栏/缩放把手上的按下 = 拖动/缩放窗口（不是"点别处收起"）——
      // conv-out 期间若在此收起并还原左扩几何，会把正在进行的拖动首帧跳 182px
      if (t.closest && t.closest('.chat-drag-bar-t, .chat-drag-bar-l, .conv-resize-handle')) return;
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
