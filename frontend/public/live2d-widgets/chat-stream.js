// ═ ChatStream：对话交互层（sendMessage 全流程/命令执行/面板 UI 控件）══
// 20260828o 拆分自 autoload.js initChat 巨型闭包（原 1182-2091 行）。逻辑零改动，
// 共享符号统一走 ctx.dom / ctx.state / engine API（数据层在 chat-engine.js）。
(function (g) {
  'use strict';
  g.__waifuStream = function (ctx, engine) {
    if (!ctx || !engine || !ctx.core || !ctx.render) {
      console.error('[chat-stream] 缺少 ctx/engine——chat-core/chat-render/chat-engine 未加载或加载顺序错误');
      return null;
    }
    const __chatCore = ctx.core;
    const { applyMsg, renderAgentContent } = ctx.render;
    const { messages, input, sendBtn, navConfirm, navQuestion, chatPanel } = ctx.dom;
    const scrollToBottom = engine.scrollToBottom;
    const broadcast = engine.broadcast;
    const pullHistory = engine.pullHistory;
    const saveHistory = engine.saveHistory;
    const apiDiscard = engine.apiDiscard;
    const appendMsg = engine.appendMsg;
    const makeProcessBox = engine.makeProcessBox;
    const getCollapsePref = engine.getCollapsePref;
    const setCollapsePref = engine.setCollapsePref;

    const init = () => {
      // 20260828o：面板元素由 engine.init 注入（#waifu 缺失时 engine 走 500ms
      // 重试，chatHTML 尚未挂载）——此处独立等待，避免对 null 绑定事件
      if (!chatPanel) { setTimeout(init, 500); return; }
      const sendMessage = async () => {
        // 图片随消息发送（多模态 20260828，20260828s 多图）：无文字只有图也允许
        // （模型描述图片）；最多 6 张（addPendingImage 上限，发送时不再拦截）
        const msg = input.value.trim();
        const imgs = ctx.state.pendingImages || [];
        if ((!msg && !imgs.length) || ctx.state.isSending) return;

        // 新对话开始：自动关闭上一条遗留的"建议跳转"面板——用户没点击/没取消时
        // 不应让它残留到下一轮（已确认的目标由用户点击触发，不受影响）
        if (ctx.state.pendingNavUrl) {
          navConfirm.classList.remove('active');
          ctx.state.pendingNavUrl = '';
        }

        // 登录检查
        const token = localStorage.getItem('tokenKey');
        if (!token) {
          const notice = '尊敬的访客：\n\n本站部署的AI虚拟形象Agent（导航/解读助手）仅供技术学习交流与功能展示使用，不视为面向公众开放的经营性AI服务。\n\n为严格遵守《生成式人工智能服务管理暂行办法》等相关法律法规，履行合规义务，本项目已采取访问限制措施，当前未向不特定公众开放。\n\n如您确因学习、交流或前端技术测试需要体验该功能，请通过博客顶部或关于页面的联系方式，联系管理员申请临时体验账号。管理员将在确认您的需求后，为您开通限时访问权限。\n\n感谢您的理解与支持！\n我们始终坚持合规先导，也期待与各位爱好者共同交流学习。\n\nSaudade Blog\n2026年7月29日';
          const it = __chatCore.migrateItem({ type: 'agent', text: notice, time: Date.now() });
          ctx.state.items.push(it);
          appendMsg(it);
          saveHistory();
          return;
        }

        // 20260829a：发送前同步压缩缩略图（180px/JPEG 0.7，每张几百字节~几 KB，
        // canvas 小尺寸毫秒级，不阻塞发送）——随 userItem/广播携带：saveHistory
        // 落盘 thumbs（刷新恢复真图）、pull 回填与远端窗口的缩略图来源一致。
        // 压缩失败的条目被过滤掉（回退 hasImg 占位，刷新显示占位块而非丢历史）
        const thumbs = imgs.length ? await makeThumbs(imgs) : [];
        if (ctx.state.isSending) return; // 压缩 await 窗口期被并发点击发送，放弃本轮

        // 本轮 roundId：跨窗同步锚点（远端按它定位 live 气泡；本窗与远端轮次
        // roundId 不同 → 双窗并发互不覆盖）。用户条目 id 独立生成（'l' 前缀），
        // discard 广播按它双侧删除（Rust 侧已按用户消息删除 DB 记录）。
        const roundId = __chatCore.genId();
        const userItemId = __chatCore.genId();
        ctx.state.activeRound = { roundId, userItemId }; // 供 3s 保险/外部清理精确锚定本轮
        input.value = '';
        // 程序清空不会触发 input 事件：主动重置高度，避免空输入框残留多行高度
        // （flex 布局下还会连带拉伸发送按钮导致变形）
        resizeInput();
        // 图片已随本轮发送：清空预览与待发状态（abort 停止生成路径不清空，可重发）
        ctx.state.pendingImages = [];
        renderPreviews();
        // 带图消息（20260828 改进②，20260828s 多图）：气泡内直接展示图片——
        // item.images 存 dataURL 数组（会话内渲染用）。20260829a 起落盘走本地
        // 缩略图方案：发送前同步压缩 180px 缩略图到 item.thumbs（上文），
        // saveHistory 落盘 thumbs（原图不落盘）——刷新/重开窗口恢复真图
        // （不再回退占位块）；旧缓存/压缩失败条目由 saveHistory 回退 hasImg 占位
        const userItem = __chatCore.migrateItem({
          id: userItemId, type: 'user', text: msg, time: Date.now(),
          ...(imgs.length ? { images: imgs, thumbs } : {}),
        });
        ctx.state.items.push(userItem);
        appendMsg(userItem);
        // 发送即回底（聊天软件标准）：即使之前在翻历史，自己发的消息必须可见
        scrollToBottom(messages, true);
        saveHistory(); // 游客立即落缓存（带 thumbs）；登录用户 DB 侧由 Rust 在流开始前入库
        // 20260829a：user 帧带 images + thumbs 跨窗广播——其他窗口直接渲染真图
        // （用户要求"其他窗口不要只显示🖼️占位块"），并随帧携带缩略图（远端窗口
        // 的 saveHistory 同样落盘 thumbs，刷新同样恢复真图）。dataURL 广播内存
        // 可接受（≤6×1MB 会话级）；hasImg 保留作兜底（旧版广播/无图帧）。
        // 回环排除靠 from=windowId 已有。注意：远端窗口 pullHistory 后 images
        // 由 replaceWithIncoming 从本地回填（回填同步透传 thumbs），会话内持续显示
        broadcast({
          t: 'user', id: userItemId, text: msg, time: userItem.time, from: engine.windowId,
          ...(imgs.length ? { images: imgs, thumbs } : {}),
          hasImg: imgs.length ? 1 : 0,
        });
        ctx.state.isSending = true;
        ctx.state.stoppedByUser = false;
        ctx.state.discardTurn = false;
        // 发送按钮切换为"停止生成"（主流对话 UI 形态），点击即中止输出
        sendBtn.disabled = false;
        sendBtn.title = '停止生成';
        sendBtn.innerHTML = '<span class="chat-stop-icon"></span>';
        sendBtn.classList.add('stop-mode');
        input.disabled = true;
        // 打字指示器（静默反馈）：流进行中 >1.2s 无帧（LLM 首 token/工具执行间隙）
        // → 气泡内三点跳动；收到任意帧 → 隐藏并重新计时。声明在 try 外，
        // catch/正常收尾都能安全清理（try 内 const 是块级作用域，catch 访问不到）
        let typingEl = null, typingTimer = null;
        // 命令行/展示文本累积变量提升到 try 外：catch 异常路径（流中断/__ERROR__）也要
        // 能访问已收到的命令帧——实测反射质检挂起 → 流中断 → catch 分支不解析导航，
        // AUTO_NAVIGATE 命令白发、用户"卡死"且不跳转（20260827g 修复）
        let cmdText = '', displayText = '';
        // 过程行累积也提升到 try 外：catch 异常路径保存回复时要带过程行（20260827g）
        let steps = [];
        // 命令解析执行（导航/特效/夜间模式）：正常收尾与异常中断共用（20260827g）。
        // 历史教训见原内联注释：模型幻觉"去X板块"时手写命令文本（多为相对路径
        // AUTO_NAVIGATE:/talk），旧实现只认完整 URL → 幻觉命令静默失效 → "没转跳"。
        // 因此：① fullText 命令行锚定解析（AUTO_NAVIGATE→直接跳 / NAVIGATE→确认，
        // 支持相对路径与格式漂移）；② 无命令行时回退正文链接（确认式）。
        // contentSpan 为 null 时（catch 异常路径，错误气泡已提示）跳过注记插入。
        const execAgentCommands = (fullText, contentSpan) => {
            const cmdNav = (() => {
              let last = null;
              for (const line of fullText.split('\n')) {
                const m = line.match(/^\s*(AUTO_NAVIGATE|NAVIGATE)\s*:\s*((?:https?:)?\/\/[^\s一-鿿　-〿＀-￯]+|\/[\w\-._~/]*)/i);
                if (!m) continue;
                // 去掉行尾中文/ASCII 标点（URL 内合法的 . 必须保留——域名全靠它）
                let url = m[2].replace(/[，。,.?!；;]+$/, '');
                if (url.startsWith('//')) url = 'https:' + url;       // 协议相对 → 补全 scheme
                else if (!/^https?:/i.test(url)) url = 'https://saudade.site' + url; // 相对路径 /talk → 站点根
                if (!/^https?:\/\//i.test(url)) continue;
                last = { url, direct: m[1].toUpperCase() === 'AUTO_NAVIGATE' };
              }
              return last;  // 取最后命中：REVISE 轮次的旧命令已作废，最终轮的才算数
            })();
            // 正文兜底解析：模型可能把命令写进回复正文（token 分帧后进不了 cmdText）。
            // 旧实现只认 https:// 完整 URL——幻觉命令多为相对路径（AUTO_NAVIGATE:/talk）
            // 或与下文粘连无换行（AUTO_NAVIGATE:/device-console主人，...），解析失败
            // 则静默无跳转。现在：① 命令前缀后支持完整 URL/协议相对/站内相对路径，
            // URL 字符集天然截断粘连中文；② AUTO_NAVIGATE 前缀即使出现在正文也按
            // "直接跳"处理——BLOG_ROUTES 白名单 + 同源 host 校验兜底，不会放行非法目标。
            const fallbackNav = (() => {
              // 取最后一处命令命中：多轮 REVISE 文本拼接时，靠前的命令属于被作废的
              // 旧轮次（曾出现旧轮次 AUTO_NAVIGATE:/ 根路径顶掉最终正确命令的案例）
              const m1s = [...fullText.matchAll(/(AUTO_NAVIGATE|NAVIGATE):\s*((?:https?:)?\/\/[^\s一-鿿　-〿＀-￯]+|\/[\w\-._~/]*)/gi)];
              const m1 = m1s.length ? m1s[m1s.length - 1] : null;
              if (m1) {
                // 去掉行尾中文/ASCII 标点（URL 内合法的 . 必须保留——域名全靠它）
                let url = m1[2].replace(/[，。,.?!；;]+$/, '');
                if (url.startsWith('//')) url = 'https:' + url;            // 协议相对 → 补全 scheme
                else if (!/^https?:/i.test(url)) url = 'https://saudade.site' + url; // 相对路径 → 站点根
                if (/^https?:\/\//i.test(url)) {
                  return { url, direct: m1[1].toUpperCase() === 'AUTO_NAVIGATE' };
                }
              }
              // 站内相对路径 markdown 链接（确认式）
              // （排除 // 开头，避免误吞协议相对地址）
              const m2b = fullText.match(/\[([^\]]+)\]\((\/(?!\/)[^)]+)\)/);
              if (m2b) return { url: 'https://saudade.site' + m2b[2], direct: false };
              // 完整 URL markdown 链接（确认式）：scheme 必须存在（http(s):// 或 // 开头），
              // 否则 [文字](/article/16) 会被拼成 https:///article/16 这种坏链接
              const m2 = fullText.match(/\[([^\]]+)\]\(((?:https?:)?\/\/[^)]+)\)/);
              if (m2) {
                let url = m2[2];
                if (url.startsWith('//')) url = 'https:' + url;
                return { url, direct: false };
              }
              // 中文命令 + 裸 URL（确认式）：排除空白/中日韩字符（URL 内合法的 . 和 , 保留），
              // 仅去掉结尾的 ASCII 标点（避免 https://example.com 被截成 https://example）
              const m3 = fullText.match(/(?:转跳|跳转|打开|前往|导航到)\s*(https?:\/\/[^\s一-鿿　-〿＀-￯]+)/i);
              if (m3) return { url: m3[1].replace(/[,.;!?]+$/, ''), direct: false };
              // 中文命令 + 裸站内相对路径（确认式）：无命令前缀的相对路径无法区分
              // "转跳 /guestbook" 与正文里的 "/article/16" 引用，故不直接跳，弹确认框
              const m3b = fullText.match(/(?:转跳|跳转|打开|前往|导航到)\s*(\/[\w\-._~/]+)/i);
              if (m3b) return { url: 'https://saudade.site' + m3b[1], direct: false };
              return null;
            })();
            const navUrl = cmdNav ? cmdNav.url : (fallbackNav && fallbackNav.url);
            if (navUrl) {
              // 直接跳转 = 命令行锚定命中 AUTO_NAVIGATE，或正文兜底解析到 AUTO_NAVIGATE 前缀
              const isDirect = (cmdNav ? cmdNav.direct : false) || (fallbackNav ? fallbackNav.direct : false);
              // 防呆：自动整页跳转前校验目标是博客真实路由。agent 可能幻觉出不存在的
              // 页面（如 /iot），跳过去会丢失整站布局与聊天面板（曾导致"文本框卡死"）。
              // 不在白名单内的目标取消跳转，并在对话框追加系统提示。
              // 模型幻觉输出可能省略尾部斜杠（AUTO_NAVIGATE:/device-console）——device-console 的斜杠可选。
              // 20260828b：命令与正文同行时也可能保留尾斜杠（AUTO_NAVIGATE:…/guestbook/ 喵呜～…），
              // 全部站内页面路由统一容忍尾斜杠（曾把 /guestbook/ 误拦成"非博客页面"——实测案例）
              const BLOG_ROUTES = [/^\/$/, /^\/about\/?$/, /^\/friends\/?$/, /^\/guestbook\/?$/, /^\/talk\/?$/, /^\/times\/?$/, /^\/login\/?$/, /^\/dashboard/, /^\/category\//, /^\/article\//, /^\/device-console\/?/];
              const navPath = (() => { try { return new URL(navUrl).pathname; } catch(e3) { return null; } })();
              const navOk = !!navPath && BLOG_ROUTES.some(r => r.test(navPath));
              // 直接跳转额外校验同源：白名单只查 pathname，幻觉的
              // AUTO_NAVIGATE:https://evil.com/talk 路径合法但会带用户离开本站 → 阻断（降级确认式）
              const hostOk = (() => { try { return new URL(navUrl).host === window.location.host; } catch(e4) { return false; } })();
              if (isDirect) {
                if (!navOk || !hostOk) {
                  console.warn('[agent] 已取消跳转到非博客页面: ' + navUrl);
                  if (contentSpan) contentSpan.insertAdjacentHTML('beforeend', '<div class="nav-skip-note">（系统：该地址不是博客页面，已取消自动跳转）</div>');
                } else {
                  sessionStorage.setItem('chat_open', '1');  // 跳转后默认打开对话框并滚动到底部
                  sessionStorage.setItem('chat_nav_slide', '1');  // 站内转跳：跳过滑入动画（forceSlideInFromBottom）
                  // 20260828a：备份块已删除——本轮由 finishRound 的 saveHistory 落缓存，
                  // 新页面 DB 权威拉取（/api/chat/history），localStorage 仅游客/离线兜底
                  window.location.href = navUrl;
                }
              } else {
                ctx.state.pendingNavUrl = navUrl;
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
        };
        // 20260828a：agent 回复保存统一走 saveHistory（唯一写者，含变更检测），
        // saveAgentMsg 三级降级已并入（QuotaExceeded 止损/JSON 损坏兜底在 saveHistory 内）

        let div = null, contentSpan = null; // live 气泡（catch 异常路径 failRound 也要引用转正，提升到 try 外）
        // 空闲/总超时计时器：声明提升到 try 外——catch 异常路径也要 clearTimeout
        // （块级 let 在 try 内声明会让 catch 引用抛 ReferenceError）
        let idleTimer = null, totalTimer = null;
        try {
          // SSE 流式对话：agent 首 token 即上屏，不再等待完整回复
          const ctrl = new AbortController();
          ctx.state.streamCtrl = ctrl;
          // 空闲超时：超过 45s 无任何数据帧则中止（正常生成中每帧都会重置；
          // LLM 工具调用间隙通常 <15s，45s 无帧 = 链路已挂，比旧的 120s 早恢复界面，
          // 曾见请求挂起时用户等 2 分钟仍"卡死"、期间发送按钮被 isSending 拦住）
          idleTimer = setTimeout(() => ctrl.abort(), 45000);
          const armIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => ctrl.abort(), 45000);
          };
          // 总超时（300s，与后端 STREAM_TOTAL_TIMEOUT 对齐）：agent 工具调用循环等场景
          // 每轮都有帧会重置空闲计时，此计时器不被重置，保证界面必然恢复
          totalTimer = setTimeout(() => ctrl.abort(), 300000);
          const resp = await fetch('/api/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({
              message: msg,
              // 20260829b：无图消息省略 image 字段——发空数组会让 Rust 误拼
              // [图片] 落库（Some(_) 分支），pull 后全部 user 气泡出现图片图标
              ...(imgs.length ? { image: imgs } : {}), // 多模态：dataURL 数组（每张 ≤1MB，最多 6 张）
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

          // 创建 live 气泡并注册到 live[roundId]（广播端按 roundId 定位；收尾
          // 转正时补 data-mid 并移出 live）。不经过 appendMsg（避免空消息进缓存）。
          // 20260828o：DOM 创建统一走 engine.makeLiveBubble（与远端 remoteLive 同源）
          const h = engine.makeLiveBubble(roundId, true);
          div = h.el;
          contentSpan = h.contentSpan;
          scrollToBottom(messages);

          // 打字指示器：插在气泡内 label 与正文之间，静默时三点跳动
          typingEl = document.createElement('span');
          typingEl.className = 'chat-typing';
          typingEl.innerHTML = '<i></i><i></i><i></i>';
          div.insertBefore(typingEl, contentSpan);
          const kickTyping = () => {
            if (typingTimer) clearTimeout(typingTimer);
            typingEl.classList.remove('typing-visible');
            typingTimer = setTimeout(() => {
              typingEl.classList.add('typing-visible');
              scrollToBottom(messages);
            }, 1200);
          };
          kickTyping();

          // ── 执行过程行（类 Claude Code 灰色可折叠轨迹）──
          // __PROCESS__:<text> 步骤帧 → 追加灰色步骤行；质检打回 __RESET__:<reason>
          // → 把被打回轮次的文本归档进可展开子项再清空重绘：最终气泡只显示诚实输出，
          //   中间过程（计划/工具调用/打回原因/被否定的回复）灰色折叠、可展开查看
          steps = [];
          let processBox = null;
          const ensureProcessBox = () => {
            if (processBox) return processBox;
            processBox = makeProcessBox(!getCollapsePref());
            // 用户手动展开/收起时记忆偏好：收起过一次后后续默认收起
            processBox.addEventListener('toggle', () => {
              setCollapsePref(!processBox.open);
            });
            div.insertBefore(processBox, contentSpan);
            return processBox;
          };
          const refreshCount = () => {
            const cnt = processBox && processBox.querySelector('.agent-process-count');
            if (cnt) cnt.textContent = steps.length ? '(' + steps.length + ')' : '';
          };
          const addStep = (cls, text) => {
            const body = ensureProcessBox().querySelector('.agent-process-body');
            const line = document.createElement('div');
            line.className = 'agent-process-line ' + cls;
            line.textContent = text;
            body.appendChild(line);
            steps.push({ cls, text });
            refreshCount();
            scrollToBottom(messages);
            broadcast({t: 'process', text, cls, roundId});  // 多标签实时同步（roundId 定位气泡）
          };
          const archiveRejected = (reason, rejectedText) => {
            const box = ensureProcessBox();
            const body = box.querySelector('.agent-process-body');
            // 若最后一步是刚由 __PROCESS__ 帧打出的同原因"✗ 质检打回"行，升级为可展开
            // 归档项（被打回轮次的完整文本放进去），避免同一原因重复出现
            const last = steps[steps.length - 1];
            if (last && last.cls === 'step' && reason && last.text.indexOf(reason) >= 0) {
              body.removeChild(body.lastChild);
              steps.pop();
            }
            const item = document.createElement('details');
            item.className = 'agent-process-reject';
            const sum = document.createElement('summary');
            sum.textContent = '✗ 质检打回：' + reason;
            const rejectedBody = document.createElement('div');
            rejectedBody.className = 'agent-process-reject-body';
            rejectedBody.textContent = rejectedText;
            item.appendChild(sum);
            item.appendChild(rejectedBody);
            body.appendChild(item);
            steps.push({ cls: 'reject', text: reason });
            refreshCount();
            scrollToBottom(messages);
          };

          // 消费 SSE：帧 = "data: <payload>\n\n"，payload 为 JSON 编码文本或终端标记
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
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
              // 有帧即"在工作"：隐藏打字指示器并重新计时（任何帧类型都算）
              kickTyping();
              if (payload.startsWith('__ERROR__:')) {
                let detail = payload.slice(10);
                try { detail = JSON.parse(detail); } catch(e) {}
                throw new Error(detail);
              }
              if (payload === '__END__' || payload === '__NAV_END__') continue;
              let text = payload;
              try { text = JSON.parse(payload); } catch(e) {}
              if (!text) continue;
              // 过程步骤帧：追加到灰色过程行（不参与展示文本/命令累积）
              if (text.startsWith('__PROCESS__:')) {
                addStep('step', text.slice('__PROCESS__:'.length));
                continue;
              }
              // REVISE 轮次重置：上一轮的文本/命令已被质检判定作废（reflector 打回），
              // 清空累积重新渲染——最终用户只看到最后一轮的完整回复，
              // 也不会把废轮次的导航命令误当最终意图；被打回的内容归档进过程行
              if (text === '__RESET__' || text.startsWith('__RESET__:')) {
                const reason = text.startsWith('__RESET__:') ? text.slice('__RESET__:'.length) : '质检未通过';
                const rejected = (cmdText + displayText).trim();
                if (rejected) {
                  archiveRejected(reason, rejected);
                } else {
                  addStep('reject-empty', '✗ 质检打回：' + reason);
                }
                cmdText = '';
                displayText = '';
                contentSpan.textContent = '';
                broadcast({t: 'reset', reason, roundId});  // 多标签同步：清空废轮次文本
                continue;
              }
              // 命令行与展示文本分流：命令行不渲染（含模型幻觉输出的变形命令如 SNOW_EFFECT:）
              if (ctx.core.COMMAND_RE.test(text)) {
                cmdText += text + '\n';
              } else {
                displayText += text;
                contentSpan.textContent = displayText;
                tickMouth();
                scrollToBottom(messages);
                broadcast({t: 'token', text, roundId});  // 多标签实时同步（roundId 定位气泡）
              }
            }
          }
          clearTimeout(idleTimer);
          clearTimeout(totalTimer);
          // 流结束：移除打字指示器（正常收尾路径）
          if (typingTimer) clearTimeout(typingTimer);
          if (typingEl) typingEl.remove();
          // 口型归位，关闭 override 让模型恢复默认驱动
          if (window.__setMouthOpen) window.__setMouthOpen(0);
          window.__mouthOverride = -1;
          contentSpan.classList.remove('msg-streaming'); // 渲染完成后恢复 normal，与博客一致
          // 完整文本（命令行前置，导航/特效解析沿用原格式）
          const fullText = cmdText + displayText;
          // 最终展示：剔除命令行与 SUMMARY 摘要行后渲染 markdown；
          // 纯命令回复（模型未输出文案）由 renderAgentContent 兜底为灰色注记
          renderAgentContent(contentSpan, fullText);
          // live 转正：进 items（含过程行）+ 补 data-mid + 移出 live + saveHistory。
          // 空回复不转正——历史里不留"泠月喵:"空气泡（转跳后恢复成"（空）"）
          if (fullText.trim()) {
            const finalItem = __chatCore.migrateItem({
              id: roundId, type: 'agent', text: fullText, time: Date.now(),
              process: steps.map(s => ({cls: s.cls, text: s.text})),
            });
            ctx.state.items = __chatCore.mergeItems(ctx.state.items, [finalItem]);
            div.dataset.mid = finalItem.id;
            div.dataset.finished = '1';
            delete ctx.state.live[roundId];
            // 广播 done 带完整条目：远端 mergeItems 转正（不写 localStorage 防写者风暴）
            broadcast({t: 'done', id: finalItem.id, fullText, time: finalItem.time,
                       process: steps.map(s => ({cls: s.cls, text: s.text})), roundId});
            saveHistory();
          } else {
            console.warn('[agent-chat] 空回复，跳过历史保存');
            delete ctx.state.live[roundId];
            if (div.parentNode) div.parentNode.removeChild(div);
            broadcast({t: 'done', id: roundId, fullText: '', time: Date.now(), process: [], roundId});
          }
          // 命令解析执行（导航/特效/夜间模式）——正常收尾路径：
          // 完整文本含命令行（fullText = cmdText + displayText），已收到的命令帧在此执行
          execAgentCommands(fullText, contentSpan);
        } catch(e) {
          // 异常路径兜底：移除打字指示器（AbortError/网络错误/__ERROR__ 帧）
          if (typingTimer) clearTimeout(typingTimer);
          if (typingEl) typingEl.remove();
          clearTimeout(idleTimer);
          clearTimeout(totalTimer);
          // 20260828o 修复：连接层失败（fetch 抛错/45s 空闲超时 abort）发生在
          // makeLiveBubble 之前时 contentSpan 为 null——下方 applyMsg(contentSpan)
          // 会抛 TypeError 导致错误文案丢失、气泡缺失（实测：断流时用户只看到
          // 自己的消息没有错误提示）。此处自建错误气泡（无 mid，不转正不保存，
          // 与 __ERROR__ 帧路径的"空气泡"语义一致）。
          if (!contentSpan) {
            try {
              const h = engine.makeLiveBubble(roundId, false);
              div = h.el;
              contentSpan = h.contentSpan;
            } catch(e2) { /* 极端情况下气泡创建失败也继续走复位逻辑 */ }
          }
          if (e && e.name === 'AbortError') {
            if (ctx.state.stoppedByUser) {
              // 用户主动停止生成：标记丢弃本轮，复位后 discardTurn() 统一清理
              // （内存/缓存/DOM 删除 + discard 广播 + DB 由 Rust DiscardAbortedExchange 删）
              ctx.state.discardTurn = true;
            } else {
              const errMsg = '长时间未收到回复，请稍后重试';
              applyMsg(contentSpan, errMsg);
              broadcast({t: 'error', msg: errMsg, roundId});
              // 异常中断也保存已收到的回复（20260827g）：断流不代表内容无效——
              // 先转正保存再跳转，新页面 DB/缓存恢复完整
              if ((cmdText + displayText).trim()) {
                const partialItem = __chatCore.migrateItem({
                  id: roundId, type: 'agent', text: cmdText + displayText, time: Date.now(),
                  process: steps.map(s => ({cls: s.cls, text: s.text})),
                });
                ctx.state.items = __chatCore.mergeItems(ctx.state.items, [partialItem]);
                div.dataset.mid = roundId;
                div.dataset.finished = '1';
                delete ctx.state.live[roundId];
                broadcast({t: 'done', id: partialItem.id, fullText: partialItem.text,
                           time: partialItem.time, process: partialItem.process, roundId});
                saveHistory();
              } else {
                delete ctx.state.live[roundId];
              }
              // 异常中断也执行已收到的命令帧（20260827g）：流中断不代表命令无效——
              // 反射质检挂起导致的断流里 AUTO_NAVIGATE/EFFECT/DARKMODE 帧可能已到达
              try { execAgentCommands(cmdText + displayText, null); } catch(e2) {/* ignore */}
            }
          } else {
            const errMsg = '网络错误: ' + (e && e.message ? e.message : '未知错误');
            applyMsg(contentSpan, errMsg);
            broadcast({t: 'error', msg: errMsg, roundId});
            // 同上：__ERROR__ 帧/网络错误也保存已收到的回复，再执行命令帧
            if ((cmdText + displayText).trim()) {
              const partialItem = __chatCore.migrateItem({
                id: roundId, type: 'agent', text: cmdText + displayText, time: Date.now(),
                process: steps.map(s => ({cls: s.cls, text: s.text})),
              });
              ctx.state.items = __chatCore.mergeItems(ctx.state.items, [partialItem]);
              div.dataset.mid = roundId;
              div.dataset.finished = '1';
              delete ctx.state.live[roundId];
              broadcast({t: 'done', id: partialItem.id, fullText: partialItem.text,
                         time: partialItem.time, process: partialItem.process, roundId});
              saveHistory();
            } else {
              delete ctx.state.live[roundId];
            }
            try { execAgentCommands(cmdText + displayText, null); } catch(e2) {/* ignore */}
          }
        } finally {
          // 复位必须在 finally：catch 内 applyMsg/broadcast 万一抛错，
          // 未复位 isSending 会把对话框永久锁死（后续发送全部被拦，即"卡死"）
          ctx.state.isSending = false;
          ctx.state.streamCtrl = null;
          sendBtn.disabled = false;
          sendBtn.title = '发送';
          sendBtn.innerHTML = '发送';
          sendBtn.classList.remove('stop-mode');
          input.disabled = false;
          input.focus();
          // 流式中被推迟的 DB 拉取在此补拉（storage 事件可能在流中到达）
          if (ctx.state.pendingPull) { ctx.state.pendingPull = false; setTimeout(pullHistory, 0); }
        }
        if (ctx.state.discardTurn) {
          // 丢弃本轮用户输入与部分回复（不加入记忆）：
          // 1) 前端内存/缓存移除本轮用户消息与 live 气泡（部分回复从未写入缓存）
          // 2) 后端 DB 记忆由 Rust /chat/stream 在流中断时自动清理（chat.rs DiscardAbortedExchange）
          ctx.state.discardTurn = false;
          const victim = ctx.state.live[roundId];
          if (victim) {
            if (victim.el && victim.el.parentNode) victim.el.parentNode.removeChild(victim.el);
            delete ctx.state.live[roundId];
          }
          ctx.state.items = ctx.state.items.filter(i => i.id !== userItemId);
          saveHistory();
          broadcast({t: 'discard', roundId, userItemId}); // 远端同删该轮（DB 侧自动清理）
          setTimeout(pullHistory, 0); // DB 可能已删（DiscardAbortedExchange），收敛一致
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
            pullHistory(); // 每次打开都同步所有窗口的聊天记录（DB 权威）
            input.focus();
            // 打开面板 = 要看最新对话：强制回底（覆盖收起前的历史浏览位置）
            setTimeout(() => scrollToBottom(messages, true), 50);
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
            pullHistory();
            const it = __chatCore.migrateItem({ type: 'agent', text: '目前博客只有泠月喵一个人服务呢，还没有招聘到新员工替本喵顶班~', time: Date.now() });
            ctx.state.items.push(it);
            appendMsg(it);
            scrollToBottom(messages, true);
            saveHistory();
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
            pullHistory();
            const it = __chatCore.migrateItem({ type: 'agent', text: '本喵还没有新衣服呢，要不要给本喵买一件呢~', time: Date.now() });
            ctx.state.items.push(it);
            appendMsg(it);
            scrollToBottom(messages, true);
            saveHistory();
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

      // 夜间时段自动切换已迁移到前端默认行为（App.tsx，不依赖看板娘脚本/agent）：
      // 23:00-次日06:00 主动开启夜间，其余时段恢复日间；访客选择过则尊重意愿不覆盖。
      // 本文件仅保留 agent DARKMODE: 命令与状态同步，避免双份定时器竞争。

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
        if (ctx.state.isSending) {
          // 输出中点击 = 停止生成
          ctx.state.stoppedByUser = true;
          if (ctx.state.streamCtrl) ctx.state.streamCtrl.abort();
          // 显式告知后端全删本轮（DB 侧 user+残缺回复；与连接中断"保留 user"互补）
          apiDiscard();
          // 保险：极端情况下（浏览器对已开始读取的流 abort 不触发 AbortError）catch 不会执行，
          // UI 会卡死在"停止生成"状态——3s 后强制恢复并丢弃本轮，保证界面必能继续使用。
          // 与 sendMessage 收尾 discardTurn 分支相同的丢弃逻辑（abort 未触发时手动清理）
          setTimeout(() => {
            if (ctx.state.isSending && ctx.state.stoppedByUser) {
              ctx.state.isSending = false;
              ctx.state.streamCtrl = null;
              sendBtn.disabled = false;
              sendBtn.title = '发送';
              sendBtn.innerHTML = '发送';
              sendBtn.classList.remove('stop-mode');
              input.disabled = false;
              const r = ctx.state.activeRound;
              const victim = ctx.state.live[r.roundId];
              if (victim) {
                if (victim.el && victim.el.parentNode) victim.el.parentNode.removeChild(victim.el);
                delete ctx.state.live[r.roundId];
              }
              if (r.userItemId) {
                ctx.state.items = ctx.state.items.filter(i => i.id !== r.userItemId);
                saveHistory();
                broadcast({t: 'discard', roundId: r.roundId, userItemId: r.userItemId});
                apiDiscard(); // 保险路径同样通知后端全删（避免 DB 残留半轮）
              }
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

      // ── 图片输入（多模态 20260828，20260828s 多图）：按钮选图 / 粘贴图片 → 压缩 →
      // 预览（最多 6 张，每图右上角 × 逐个移除）→ 随消息发送 ──
      // 状态放 ctx.state.pendingImages（数组，跨函数共享）：abort 停止生成不清空，
      // 可重发；超 6 张拒绝并提示
      const imgBtn = document.getElementById('chat-img-btn');
      const imgFile = document.getElementById('chat-img-file');
      const imgPreview = document.getElementById('chat-img-preview');
      // 预览区动态填充：每张缩略图一个容器（img + 右上角 ×），移除即从数组 splice
      const renderPreviews = () => {
        const imgs = ctx.state.pendingImages || [];
        imgPreview.innerHTML = '';
        imgs.forEach((src, i) => {
          const wrap = document.createElement('div');
          wrap.className = 'chat-img-preview-item';
          const im = document.createElement('img');
          im.src = src;
          im.alt = '已选择图片 ' + (i + 1);
          const rm = document.createElement('button');
          rm.className = 'chat-img-preview-remove';
          rm.title = '移除第 ' + (i + 1) + ' 张图片';
          rm.textContent = '×';
          rm.addEventListener('click', () => {
            ctx.state.pendingImages = ctx.state.pendingImages.filter((_, j) => j !== i);
            renderPreviews();
            input.focus();
          });
          wrap.appendChild(im);
          wrap.appendChild(rm);
          imgPreview.appendChild(wrap);
        });
      };
      const addPendingImage = (dataUrl) => {
        if ((ctx.state.pendingImages || []).length >= 6) {
          console.warn('[chat] 最多支持 6 张图片');
          return;
        }
        ctx.state.pendingImages = (ctx.state.pendingImages || []).concat(dataUrl);
        renderPreviews();
        input.focus();
      };
      // 压缩规则：base64 ≤950KB 原样走（PNG 透明小图不转 JPEG 保透明）；超过则 canvas
      // 缩放（最长边 1280 封顶，不放大）+ JPEG 0.85 重编码，保 ≤900KB（Rust 请求体 8MB
      // 上限内每张 ≤1MB 的安全线）。两次降质仍超 1MB → 放弃并提示
      const readImageFile = (file) => {
        if (!file || !file.type || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          if (dataUrl.length <= 950 * 1024) { addPendingImage(dataUrl); return; }
          const imgEl = new Image();
          imgEl.onload = () => {
            try {
              const scale = Math.min(1, 1280 / Math.max(imgEl.width, imgEl.height));
              const canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(imgEl.width * scale));
              canvas.height = Math.max(1, Math.round(imgEl.height * scale));
              canvas.getContext('2d').drawImage(imgEl, 0, 0, canvas.width, canvas.height);
              let out = canvas.toDataURL('image/jpeg', 0.85);
              if (out.length > 900 * 1024) out = canvas.toDataURL('image/jpeg', 0.7);
              if (out.length > 1024 * 1024) { console.warn('[chat] 图片压缩后仍超限，已放弃'); return; }
              addPendingImage(out);
            } catch(e) { console.warn('[chat] 图片压缩失败', e); }
          };
          imgEl.onerror = () => console.warn('[chat] 图片解码失败');
          imgEl.src = dataUrl;
        };
        reader.readAsDataURL(file);
      };
      // 20260829a：本地缩略图——最长边 180px（匹配气泡 180px 网格展示尺寸，
      // 恢复不放大糊），JPEG 0.7（每张几百字节~几 KB）；带 alpha 的 PNG 保 PNG
      // （JPEG 会把透明区压成黑底）。解码/绘制失败 resolve(null)（由调用方过滤，
      // 该条目回退 hasImg 占位——宁缺毋滥，大 dataURL 落盘会撑爆 localStorage）
      const thumbFromDataUrl = (dataUrl) => new Promise((resolve) => {
        if (!dataUrl) return resolve(null);
        const imgEl = new Image();
        imgEl.onload = () => {
          try {
            const scale = Math.min(1, 180 / Math.max(imgEl.width, imgEl.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(imgEl.width * scale));
            canvas.height = Math.max(1, Math.round(imgEl.height * scale));
            const c2 = canvas.getContext('2d');
            let isPng = dataUrl.startsWith('data:image/png');
            if (isPng) { // 仅 PNG 且真带 alpha 才保 PNG；全不透明 PNG 转 JPEG 更小
              c2.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
              const d = c2.getImageData(0, 0, canvas.width, canvas.height).data;
              let hasAlpha = false;
              for (let i = 3; i < d.length; i += 4) { if (d[i] < 250) { hasAlpha = true; break; } }
              isPng = hasAlpha;
            }
            c2.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.7));
          } catch(e) { resolve(null); }
        };
        imgEl.onerror = () => resolve(null);
        imgEl.src = dataUrl;
      });
      const makeThumbs = (dataUrls) =>
        Promise.all((dataUrls || []).map(thumbFromDataUrl)).then(list => list.filter(Boolean));
      imgBtn.addEventListener('click', () => imgFile.click());
      imgFile.addEventListener('change', () => {
        const f = imgFile.files && imgFile.files[0];
        if (f) readImageFile(f);
        imgFile.value = ''; // 置空：同一文件再次选择仍触发 change
      });
      // 粘贴图片（剪贴板截图/复制图片文件）：命中 image 条目即接管，阻止文本插入干扰
      input.addEventListener('paste', (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (const it of items) {
          if (it.type && it.type.startsWith('image/')) {
            const f = it.getAsFile();
            if (f) {
              e.preventDefault();
              readImageFile(f);
            }
            break;
          }
        }
      });
      // 拖拽图片入输入栏（20260829a）：文件拖到输入栏区域即加入预览队列（复用
      // readImageFile 压缩/限流）。dragover preventDefault 是允许 drop 的必要条件
      // （浏览器默认拒绝文件落点并打开图片）；只接管含文件的拖拽，纯文本拖拽不干扰
      const inputArea = document.querySelector('.chat-input-area');
      inputArea.addEventListener('dragover', (e) => {
        const types = e.dataTransfer && e.dataTransfer.types;
        if (types && Array.from(types).includes('Files')) {
          e.preventDefault();
          inputArea.classList.add('chat-drag-over');
        }
      });
      inputArea.addEventListener('dragleave', () => inputArea.classList.remove('chat-drag-over'));
      inputArea.addEventListener('drop', (e) => {
        inputArea.classList.remove('chat-drag-over');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || !files.length) return;
        const imgs = [...files].filter(f => f.type && f.type.startsWith('image/'));
        if (!imgs.length) return;
        e.preventDefault();
        imgs.forEach(readImageFile);
        input.focus();
      });

      document.getElementById('nav-yes').addEventListener('click', () => {
        if (ctx.state.pendingNavUrl) {
          navConfirm.classList.remove('active');
          sessionStorage.setItem('chat_open', '1');  // 跳转后默认打开对话框并滚动到底部
          sessionStorage.setItem('chat_nav_slide', '1');  // 站内转跳：跳过滑入动画（forceSlideInFromBottom）
          window.location.href = ctx.state.pendingNavUrl;
          ctx.state.pendingNavUrl = '';
        }
      });
      document.getElementById('nav-no').addEventListener('click', () => {
        navConfirm.classList.remove('active');
        ctx.state.pendingNavUrl = '';
      });

      // 右上角关闭按钮：收起聊天面板
      document.getElementById('chat-close').addEventListener('click', () => {
        chatPanel.classList.remove('active');
      });
    };

    return { init };
  };
})(typeof window !== 'undefined' ? window : globalThis);
