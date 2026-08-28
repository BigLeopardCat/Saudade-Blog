// ═ ChatCore：聊天核心纯函数（无 DOM/闭包依赖，Node 可 require 直测）══
// 消息 id 三来源：'d'+DB主键（DB 拉取，跨窗天然一致）/ 'l'+随机（乐观 user/远端轮）。
// mergeItems 规则：同 id 严格替换；id 不同但 type|text 内容碰撞 → 原位收养
// （条目换成 incoming 的 id/time，position 不动——根治旧 type|time 去重误判）；
// 都不匹配 → 按 time 排序插入。
// ── 命令正则权威定义（20260828o 收敛）──
// 原 autoload.js 三份拷贝（__chatCore.COMMAND_RE / initChat.COMMAND_LINE_RE /
// stripCommandPrefix 内 RE）合并于此：COMMAND_LINE_RE 与 stripCommandPrefix RE
// 文本等价，且 test 语义与 COMMAND_RE 完全等价（参数组可选 → 前缀匹配即整体匹配；
// 所有 COMMAND_LINE_RE 调用处都先 trim，COMMAND_RE 的 ^\s* 是超集容忍，无用例可区分）。
// 现唯一权威 COMMAND_RE：行内任意位置剥段（matchText/stripCommandPrefix）与
// 行级命令判断（cleanAgentText/SSE 分流/广播剥离）统一引用，改一处即全同步。
(function (g) {
  'use strict';
  const __chatCore = (() => {
    // 20260828e：内容匹配统一走 matchText——缓存条目 text（收尾时
    // cmdText+displayText 拼接）与 DB content（原始流式文本）的构造差异：
    // ① 命令帧拼接带 '\n'（空白差异）；② 命令与正文分帧时 '\n' 插在无分隔的
    // 命令/正文之间（"…/12" + '\n' + "喵呜～" vs 原文 "…/12喵呜～"，纯空白
    // 折叠仍不等）。逐字匹配使 lookupProcess 富化/mergeItems 收养/收养渲染
    // 全失配（"转跳后执行过程丢失"根因）。解法：逐行剥行首命令段（保留同行
    // 正文，与 stripCommandPrefix 同语义）+ 空白归一后比较。
    const COMMAND_RE = /^\s*(?:[A-Za-z0-9_]*EFFECT|DARKMODE|NAVIGATE|AUTO_NAVIGATE|SUMMARY|\[?System)\]?\s*:(?:((?:https?:)?\/\/[^\s一-鿿　-〿＀-￯]+)|(\/[\w\-._~/]*)|(\s*\S+))?/;
    const stripCommand = (s) => {
      let rest = s, m;
      while ((m = rest.match(COMMAND_RE))) rest = rest.slice(m[0].length);
      return rest;
    };
    const normText = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // 注意：COMMAND_RE 为全模块唯一权威（20260828o 起），stripCommandPrefix 与
    // 各处行级命令判断（cleanAgentText/SSE 分流/广播剥离）均引用本正则
    const matchText = (a, b) => {
      const stripAll = (s) => (s || '').split('\n').map(stripCommand).join('\n');
      return normText(stripAll(a)) === normText(stripAll(b));
    };
    const genId = () => 'l' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    // 旧 localStorage 条目无 id（20260828 前格式）→ 迁移补 id
    const migrateItem = (it) => ({
      id: (it && it.id) || genId(),
      type: (it && it.type) || 'agent',
      text: (it && it.text) || '',
      time: (it && it.time) || 0,
      process: (it && Array.isArray(it.process) && it.process.length) ? it.process : undefined,
      // 多模态（20260828 改进②）：image = 会话内渲染用的 dataURL（不落盘）；
      // hasImg = 远端/恢复标记（无图数据时渲染占位块）
      image: (it && it.image) || undefined,
      hasImg: (it && it.hasImg) ? 1 : undefined,
    });
    const mergeItems = (local, incoming) => {
      const out = local.slice();
      const byId = new Set(out.map(i => i.id));
      const consumed = new Set();
      for (const inc of incoming) {
        if (byId.has(inc.id)) {
          out[out.findIndex(i => i.id === inc.id)] = inc;   // 同 id 严格替换
          continue;
        }
        let adopted = false;
        for (let j = 0; j < out.length; j++) {
          if (consumed.has(j)) continue;
          if (out[j].type === inc.type && matchText(out[j].text, inc.text)) {
            out[j] = inc; consumed.add(j); adopted = true; break;  // 内容收养（不重复）
          }
        }
        if (!adopted) out.push(inc);
      }
      out.sort((a, b) => (a.time || 0) - (b.time || 0));
      return out;
    };
    const capItems = (arr, max) => (arr.length > max ? arr.slice(-max) : arr);
    // 20260828g：服务器权威替换——incoming（DB 视图）整体替换本地 items，不保留
    // 任何本地条目（合并启发式全删除）。唯一例外：60s 内新收尾但尚未入库的
    // 'l' 轮追加尾部（DB 提交延迟窗口，防"刚发完被 pull 一闪而过"）；内容已被
    // incoming 收录的 'l' 不追加（用 'd' 版即可）。time 最新，追加尾部顺序正确。
    const replaceWithIncoming = (local, incoming, now) => {
      const out = incoming.slice();
      const t = (now === undefined ? Date.now() : now);
      for (const it of (local || [])) {
        if (it.id && it.id.startsWith('l')
            && (it.time || 0) >= t - 60000
            && !incoming.some(inc => inc.type === it.type && matchText(inc.text, it.text))) {
          out.push(it);
        }
      }
      return out;
    };
    // ── 时间标签（微信式时间分组）：会话间隔 > TIME_GAP_MS 时在新一段会话的
    // 首条消息上方显示时间。formatTimeLabel 供 Node harness 提取验证。
    const TIME_GAP_MS = 5 * 60 * 1000;
    const validTime = (t) => typeof t === 'number' && t > 0 && !isNaN(t);
    const formatTimeLabel = (ts) => {
      const d = new Date(ts);
      const now = new Date();
      // 本地日界差（非粗暴 24h 差）：23:59 与次日 00:01 不误判"昨天"
      const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
      const pad = (n) => String(n).padStart(2, '0');
      const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
      if (dayDiff <= 0) return hm;                       // 今天：HH:mm
      if (dayDiff === 1) return '昨天 ' + hm;            // 昨天
      if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
    };
    // 首条恒显示；任一时间无效（旧缓存 time=0）→ 无标签（标签文本来自 cur.time，
    // 不会渲染出 1970 日期；prev 无效视为"间隔未知"→ 显示 cur 的标签）
    const shouldShowTime = (prev, cur) => !!cur && validTime(cur.time)
      && (!prev || !validTime(prev.time) || (cur.time - prev.time > TIME_GAP_MS));
    return { genId, migrateItem, mergeItems, replaceWithIncoming, capItems, normText, matchText,
             COMMAND_RE, TIME_GAP_MS, formatTimeLabel, shouldShowTime };
  })();

  g.__waifuChatCore = __chatCore;
})(typeof window !== 'undefined' ? window : globalThis);
