// ═ ChatRender：聊天渲染层（无状态，仅依赖 ctx.core）══
// 文本清洗（命令行/裸摘要剔除）+ markdown 渲染 + 聊天面板 HTML 模板。
// 20260828o 收敛：行级命令判断原用独立 COMMAND_LINE_RE，现统一引用
// ctx.core.COMMAND_RE（权威定义在 chat-core.js，语义等价见该文件头注释）。
(function (g) {
  'use strict';
  g.__waifuRender = function (ctx) {
    if (!ctx || !ctx.core) { console.error('[chat-render] 缺少 ctx.core——chat-core.js 未加载或加载顺序错误'); return; }
    const COMMAND_RE = ctx.core.COMMAND_RE;

    // 剔除 agent 文本中的命令行（NAVIGATE:/AUTO_NAVIGATE:/EFFECT:/DARKMODE:/SUMMARY:），仅用于展示。
    // 前缀正则放宽：模型可能在正文里幻觉输出 SNOW_EFFECT:/TOKK_EFFECT: 等变形工具命令，
    // 一律按命令行剔除，不进入对话框。SYSTEM 兜底：[System: …] 是模型对系统注记的
    // 复述/幻觉（prompt 已禁止但 qwen 偶发原样透出），同样不展示
    //（权威正则 COMMAND_RE 见 chat-core.js，本模块不再自持副本）
    // 命令型回复渲染兜底：模型对导航等请求常只输出命令帧、不带确认文案
    // （DB 实证：assistant 回复 = 纯 "AUTO_NAVIGATE:..."，cleanAgentText 后为空）。
    // 旧实现渲染空气泡 → 用户误判"对话记录丢失/（空）"（本次报告的根因）。
    // 兜底：清洗后为空但含命令 → 渲染灰色系统注记，如实说明指令已执行
    const renderAgentContent = (el, fullText) => {
      const clean = cleanAgentText(fullText);
      if (clean) { applyMsg(el, clean); return; }
      if (!fullText) return;
      let note = '（系统指令已执行）';
      if (/AUTO_NAVIGATE\s*:/i.test(fullText)) note = '（已自动跳转页面）';
      else if (/NAVIGATE\s*:/i.test(fullText)) note = '（已弹出跳转确认）';
      else if (/EFFECT\s*:/i.test(fullText)) note = '（已切换页面特效）';
      else if (/DARKMODE\s*:/i.test(fullText)) note = '（已切换夜间模式）';
      const div = document.createElement('div');
      div.className = 'nav-skip-note';
      div.textContent = note;
      el.appendChild(div);
    };
    // 命令前缀剥离（20260828b）：命令与正文同行（agent 导航输出常无换行粘连，如
    // "AUTO_NAVIGATE:https://saudade.site/guestbook/ 喵呜～…"）时只剥命令段保留正文——
    // 旧实现按行整行过滤会连正文一起删；纯命令行剥后为空 → 行删除（原语义）
    // 循环剥离直到行首不再出现命令（两个命令粘连无换行时（DB 实证：
    // "AUTO_NAVIGATE:…guestbookAUTO_NAVIGATE:…"）URL 组贪婪吞到空白，单次 replace
    // 只剥第一个；while 保证剥净，剩空白则整行删除由调用方处理）
    const stripCommandPrefix = (line) => {
      // 20260828o：正则引用 chat-core 的权威 COMMAND_RE（原"改一处改两处"已收敛）
      let rest = line, m;
      while ((m = rest.match(COMMAND_RE))) rest = rest.slice(m[0].length);
      return rest;
    };
    const cleanAgentText = (text) => {
      if (!text) return '';
      let cleaned = text.split('\n')
        .map(l => {
          if (!COMMAND_RE.test(l.trim())) return l; // 非命令行原样保留
          const rest = stripCommandPrefix(l).trim();      // 命令行：剥前缀
          return rest ? rest : null;                      // 剥空（纯命令）→ 标记删除
        })
        .filter(l => l !== null)
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

    // ── Chat Panel 模板（engine.initChat 注入）──
    const chatHTML = `
    <div id="waifu-chat">
      <div class="chat-drag-bar-t"></div>
      <div class="chat-drag-bar-l"></div>
      <div class="chat-inner-border"></div>
      <div class="chat-close" id="chat-close">×</div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-new-msg-note" id="chat-new-msg-note"><span>↓ 有新消息</span></div>
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

    ctx.render = { COMMAND_RE, stripCommandPrefix, renderAgentContent, cleanAgentText, applyMsg, renderMarkdown, chatHTML };
  };
})(typeof window !== 'undefined' ? window : globalThis);
