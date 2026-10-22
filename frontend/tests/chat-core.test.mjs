// ═ ChatCore 回归锚点（20260828o 结构拆分后固化）══
// node tests/chat-core.test.mjs 运行。覆盖：时间标签（微信式分组）、
// mergeItems/replaceWithIncoming/capItems/migrateItem/matchText、命令正则权威定义。
// chat-core.js 是纯函数模块（window/globalThis 双挂载），node 直接 require 可测。
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

// frontend 是 ESM 包（"type":"module"），chat-core.js 又是普通 script（IIFE + 全局挂载），
// 用 vm 在当前全局上下文执行——与浏览器 classic script 语义一致，且不触发模块解析
const corePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/live2d-widgets/chat-core.js');
vm.runInThisContext(readFileSync(corePath, 'utf8'));
const core = globalThis.__waifuChatCore;
if (!core) { console.error('chat-core.js 未注册 __waifuChatCore'); process.exit(1); }

let passed = 0, failed = 0;
const ok = (cond, name, detail) => {
  if (cond) { passed++; }
  else { failed++; console.log('  ✗ FAIL: ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (got, exp, name) => ok(got === exp, name, { got, exp });
const truthy = (v, name) => ok(!!v, name, { got: v });
const falsy = (v, name) => ok(!v, name, { got: v });
const assert = { ok, eq, truthy, falsy };

// ── 构造相对"今天"的固定时间点（测试独立于运行日期）──
const now = new Date();
const hmOf = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
const atToday = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
const yesterdaySameTime = () => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(9, 4, 0, 0); return d.getTime(); };

console.log('== 时间标签 formatTimeLabel ==');
{
  const t = atToday(9, 4);
  assert.eq(core.formatTimeLabel(t), '09:04', '今天 → HH:mm');
  assert.eq(core.formatTimeLabel(atToday(0, 1)), '00:01', '凌晨 00:01 → HH:mm');
  assert.eq(core.formatTimeLabel(atToday(23, 59)), '23:59', '23:59 → HH:mm');
  assert.eq(core.formatTimeLabel(yesterdaySameTime()), '昨天 09:04', '昨天 → 昨天 HH:mm');
  // 本地日界差：昨天 23:59 与今天 00:01 是两个"今天/昨天"标签，不因 24h 差误判
  const t1 = atToday(23, 59), t2 = atToday(0, 1);
  const d = new Date(t1), d2 = new Date(t2);
  assert.eq(core.formatTimeLabel(t1), '23:59', '昨天 23:59 形态（跨日边界不误判）');
  assert.eq(core.formatTimeLabel(t2), '00:01', '今天 00:01 形态');
  // 同一年份（当年 1 月 1 日；若今天是 1/1 或 1/2 则分别退化为今天/昨天格式）
  const jan1 = new Date(now.getFullYear(), 0, 1, 9, 4);
  const dayDiffJan1 = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000);
  if (dayDiffJan1 <= 0) assert.eq(core.formatTimeLabel(jan1.getTime()), '09:04', '当年 1/1 且今天是 1/1 → HH:mm');
  else if (dayDiffJan1 === 1) assert.eq(core.formatTimeLabel(jan1.getTime()), '昨天 09:04', '当年 1/1 且今天是 1/2 → 昨天 HH:mm');
  else assert.eq(core.formatTimeLabel(jan1.getTime()), '1月1日 09:04', '当年 1/1 → M月D日 HH:mm');
  // 跨年份（去年 12/31 → 必然不同年）
  const dec31 = new Date(now.getFullYear() - 1, 11, 31, 9, 4);
  assert.eq(core.formatTimeLabel(dec31.getTime()), (now.getFullYear() - 1) + '年12月31日 09:04', '去年 12/31 → YYYY年M月D日 HH:mm');
}

console.log('== 时间标签 shouldShowTime（5 分钟间隔阈值）==');
{
  const t0 = atToday(9, 0);
  const valid = { id: 'a', type: 'agent', text: 'x', time: t0 };
  assert.truthy(core.shouldShowTime(null, valid), '首条恒显示');
  assert.truthy(core.shouldShowTime(undefined, valid), '无 prev（undefined）→ 显示');
  const gap6 = { ...valid, time: t0 + 6 * 60 * 1000 };
  assert.truthy(core.shouldShowTime(valid, gap6), '间隔 6 分钟 → 显示');
  const gap5 = { ...valid, time: t0 + 5 * 60 * 1000 };
  assert.falsy(core.shouldShowTime(valid, gap5), '间隔恰好 5 分钟 → 不显示（严格 >）');
  const gap4 = { ...valid, time: t0 + 4 * 60 * 1000 };
  assert.falsy(core.shouldShowTime(valid, gap4), '间隔 4 分钟 → 不显示');
  const prevInvalid = { ...valid, time: 0 };
  assert.truthy(core.shouldShowTime(prevInvalid, gap6), 'prev 时间无效（旧缓存 time=0）→ 显示 cur 标签');
  assert.falsy(core.shouldShowTime(valid, { ...valid, time: 0 }), 'cur 时间无效 → 不显示（不渲染 1970 日期）');
  assert.falsy(core.shouldShowTime(valid, null), 'cur 为 null → 不显示');
  assert.falsy(core.shouldShowTime(valid, undefined), 'cur 为 undefined → 不显示');
  // 跨日界但间隔小：昨天 23:59 → 今天 00:01（2 分钟）→ 不显示（间隔制，非日界制）
  const yesterday = new Date(atToday(23, 59));
  yesterday.setDate(yesterday.getDate() - 1);
  const prev2359 = { ...valid, time: yesterday.getTime() };
  const cur0001 = { ...valid, time: atToday(0, 1) };
  assert.eq(cur0001.time - prev2359.time, 2 * 60 * 1000, '跨日夹具真实相隔两分钟');
  assert.falsy(core.shouldShowTime(prev2359, cur0001), '23:59→00:01 间隔 2 分钟 → 不显示');
}

console.log('== matchText（命令帧拼接差异归一）==');
{
  assert.truthy(core.matchText(
    'AUTO_NAVIGATE:https://saudade.site/guestbook/ 喵呜～',
    'AUTO_NAVIGATE:https://saudade.site/guestbook/\n喵呜～'), '命令帧 \\n 拼接差异 → 相等');
  assert.truthy(core.matchText(
    'AUTO_NAVIGATE:https://saudade.site/article/12喵呜～',
    'AUTO_NAVIGATE:https://saudade.site/article/12\n喵呜～'), '分帧命令/正文间插 \\n → 相等（剥命令段后同正文）');
  assert.truthy(core.matchText('你好  世界', '你好 世界'), '多空白折叠 → 相等');
  assert.truthy(core.matchText('EFFECT:sakura:on', 'EFFECT:sakura:on'), '相同文本 → 相等');
  assert.truthy(core.matchText('', ''), '双空 → 相等');
  assert.falsy(core.matchText('你好', '你好喵'), '内容不同 → 不等');
  assert.truthy(core.matchText(
    '第一行\nAUTO_NAVIGATE:/talk\n第二行',
    '第一行\nAUTO_NAVIGATE:/talk\n第二行 '), '多行命令逐行剥离 + 空白 → 相等');
  assert.truthy(core.matchText('AUTO_NAVIGATE:/talk', 'NAVIGATE:/talk'),
    '纯命令不同命令头 → 相等（matchText 只比剥命令段后的正文，命令种类不参与）');
}

console.log('== mergeItems（同 id 替换 / 内容收养 / 追加 / 排序）==');
{
  const nowT = atToday(10, 0);
  const m1 = { id: 'd1', type: 'user', text: '你好', time: nowT };
  const m2 = { id: 'd2', type: 'agent', text: '喵呜～', time: nowT + 1000 };
  // 同 id 严格替换
  const r1 = core.mergeItems([m1, m2], [{ id: 'd2', type: 'agent', text: '喵呜～（改）', time: nowT + 1000 }]);
  assert.eq(r1.length, 2, '同 id 替换不新增');
  assert.eq(r1[1].text, '喵呜～（改）', '同 id 内容被替换');
  // 内容收养：id 不同但 type+text 碰撞 → 原位换 id（position 不动）
  const r2 = core.mergeItems([m1, m2], [{ id: 'd9', type: 'user', text: '你好 ', time: nowT }]);
  assert.eq(r2.length, 2, '内容收养不重复');
  assert.eq(r2[0].id, 'd9', '收养后条目换成 incoming 的 id');
  // 无碰撞 → 追加并按 time 排序
  const r3 = core.mergeItems([m2], [m1]);
  assert.eq(r3.length, 2, '追加');
  assert.eq(r3[0].id, 'd1', '按 time 升序排前');
  // 双收养不重复消费（两条相同内容只收养一次）
  const dup = { id: 'd10', type: 'agent', text: '喵呜～', time: nowT + 1000 };
  const r4 = core.mergeItems([m1, m2], [dup, { id: 'd11', type: 'agent', text: '喵呜～', time: nowT + 2000 }]);
  assert.eq(r4.length, 3, '重复内容只收养一条，另一条追加');
}

console.log('== replaceWithIncoming（服务器权威 + 60s 乐观窗口）==');
{
  const t = atToday(11, 0);
  const inc = [
    { id: 'd1', type: 'user', text: '在吗', time: t - 60000 },
    { id: 'd2', type: 'agent', text: '在的喵～', time: t - 59000 },
  ];
  // 60s 内未入库的 'l' 轮保留追加
  const fresh = { id: 'l-fresh', type: 'agent', text: '刚发完', time: t - 5000 };
  const r1 = core.replaceWithIncoming([fresh], inc, t);
  assert.eq(r1.length, 3, '60s 内新 l 轮追加保留');
  assert.eq(r1[2].id, 'l-fresh', '追加在尾部');
  // 旧 'l'（超 60s）被整体替换丢弃
  const stale = { id: 'l-stale', type: 'agent', text: '旧的', time: t - 70000 };
  const r2 = core.replaceWithIncoming([stale], inc, t);
  assert.eq(r2.length, 2, '超 60s 的 l 被丢弃');
  // 内容已被 incoming 收录的 'l' 不追加（用 'd' 版即可）
  const dup = { id: 'l-dup', type: 'agent', text: '在的喵～', time: t - 30000 };
  const r3 = core.replaceWithIncoming([dup], inc, t);
  assert.eq(r3.length, 2, '内容已被收录的 l 不追加');
  // 本地旧条目（'d' 且不在 incoming）→ 整体替换丢弃（无合并启发式）
  const oldD = { id: 'd9', type: 'user', text: '老记录', time: t - 3600000 };
  const r4 = core.replaceWithIncoming([oldD, fresh], inc, t);
  assert.eq(r4.length, 3, '本地 d 旧条目被替换丢弃');
}

console.log('== capItems / migrateItem ==');
{
  const mk = (i) => ({ id: 'd' + i, type: 'agent', text: 't' + i, time: i });
  const capped = core.capItems([mk(1), mk(2), mk(3)], 2);
  assert.eq(capped.length, 2, 'cap 保留尾部');
  assert.eq(capped[0].id, 'd2', 'cap 保留最近 2 条');
  assert.eq(core.capItems([mk(1)], 5).length, 1, '不足上限不截');
  // migrateItem
  const old = { type: 'user', text: '旧格式', time: 123 };
  const mig = core.migrateItem(old);
  assert.truthy(mig.id, '旧格式补 id');
  assert.eq(mig.type, 'user', 'type 保留');
  assert.eq(mig.text, '旧格式', 'text 保留');
  assert.eq(mig.time, 123, 'time 保留');
  assert.eq(mig.process, undefined, '无 process 不补');
  const migEmpty = core.migrateItem(null);
  assert.eq(migEmpty.type, 'agent', 'null → 默认 type');
  assert.eq(migEmpty.text, '', 'null → 默认 text');
  assert.eq(migEmpty.time, 0, 'null → 默认 time');
  const migProc = core.migrateItem({ process: [] });
  assert.eq(migProc.process, undefined, '空 process 数组 → undefined');
  const migProc2 = core.migrateItem({ process: [{ cls: 'step', text: 'x' }] });
  assert.eq(migProc2.process.length, 1, '非空 process 保留');
}

console.log('== 聊天图片（20261018：DB 行 → 气泡，images 不许被吃掉）==');
{
  const eqArr = (got, exp, name) => ok(JSON.stringify(got) === JSON.stringify(exp), name, { got, exp });
  const DB_IMG = 'data:image/png;base64,iVBORw0KGgo+/x==';
  const DECOY_THUMB = 'data:image/jpeg;base64,DECOY-DECOY-DECOY==';

  // ── dbRowToItem：DB 行的字段映射 ──────────────────────────────────────────
  const row = { id: 42, role: 'user', content: '看这张\n[图片]', time: 1700000000000, images: [DB_IMG] };
  const bare = core.dbRowToItem(row);
  assert.eq(bare.id, 'd42', 'id 加 d 前缀（前端稳定去重 id）');
  assert.eq(bare.type, 'user', "role='user' → type='user'");
  assert.eq(bare.text, '看这张\n[图片]', 'text = content（标记的剥离在 replaceWithIncoming，不在这儿）');
  eqArr(bare.images, [DB_IMG], '**images 原样带过去**（这一格以前被白名单吃掉）');
  assert.eq(core.dbRowToItem({ ...row, role: 'assistant' }).type, 'agent', 'assistant → agent');

  // ── mapDbItems：漏传 lookupProcess 必须**抛**，不许静默默认 ────────────────
  // 漏传的后果是 pullHistory 的 catch 静默降级成本地缓存（只有一行 console），
  // 症状是"图不显示"——所以这里要响亮。
  let threw = false;
  try { core.mapDbItems([row]); } catch { threw = true; }
  assert.truthy(threw, 'mapDbItems 漏传 lookupProcess 要抛（漏传会静默退化成无过程行）');
  const mapped = core.mapDbItems([row], () => undefined);
  eqArr(mapped[0].images, [DB_IMG], '经 mapDbItems → migrateItem 之后 images 仍在');
  assert.eq(mapped[0].process, undefined, 'user 行不查过程行');

  // ── replaceWithIncoming：DB 有图 ⇒ 不许回填、不许补占位 ────────────────────
  // ⚠️ 两个"空真"陷阱，缺一个这条判据就是假的：
  //   ① 夹具 content **必须**以 `\n[图片]` 结尾 —— needFill 要求文本匹配 /\[图片(?:×\d+)?\]/，
  //      不带标记的话回填分支根本不进，"没触发回填"就成了空真；
  //   ② local 里**必须**放一条同文本、带 thumbs 的**诱饵** —— 否则 withImg 为空，
  //      回填照样不进，"没触发"还是空真。
  // 诱饵的图与 DB 的图**不同**，所以"回填发生了"会当场改变 images 的值（不是靠运气）。
  const local = [core.migrateItem({
    id: 'l-1', type: 'user', text: '看这张\n[图片]', time: 1700000000000,
    thumbs: [DECOY_THUMB],
  })];
  assert.eq(local[0].images[0], DECOY_THUMB, '前提：诱饵带的是缩略图（withImg 非空）');
  const out = core.replaceWithIncoming(local, mapped, 1700000000000);
  assert.eq(out.length, 1, '同一条消息不该被追加成两条');
  eqArr(out[0].images, [DB_IMG],
    '**images 必须还是 DB 那份**：回填只在 DB 没图时发生，DB 有图时拿本地缩略图去顶' +
    '会把原图降级成 180px 缩略图（且是不可逆的——下次 saveHistory 就把它当唯一的图存下去）');
  assert.eq(out[0].hasImg, undefined,
    '有图就不该有 hasImg —— 置位会让前端渲染"ⓘ图片已过期"占位块盖住真图');
  assert.eq(out[0].text, '看这张', 'DB 文本里的 [图片] 标记要剥掉（否则图文重复展示）');

  // ── 老轮次（DB 没图，只有标记）：走占位块，是诚实的那一条路径 ──────────────
  const lost = core.mapDbItems(
    [{ id: 7, role: 'user', content: '早就丢了\n[图片×2]', time: 1600000000000, images: [] }],
    () => undefined,
  );
  const out2 = core.replaceWithIncoming([], lost, 1600000000000);
  assert.eq(out2[0].images, undefined, '空数组 = 这条没图（不是缺键，也不是残缺数组）');
  assert.eq(out2[0].hasImg, 1, '真图消息但图没了 → 占位块（存量那 7 条就是这种）');
  assert.eq(out2[0].text, '早就丢了', '标记照剥');
}

console.log('== 命令正则权威 COMMAND_RE ==');
{
  const RE = core.COMMAND_RE;
  assert.truthy(RE.test('EFFECT:sakura:on'), 'EFFECT 全形');
  assert.truthy(RE.test('EFFECT:sakura'), 'EFFECT 无参数');
  assert.truthy(RE.test('EFFECT: sakura on'), 'EFFECT 空格变形');
  assert.truthy(RE.test('DARKMODE:on'), 'DARKMODE');
  assert.truthy(RE.test('DARKMODE: on'), 'DARKMODE 空格变形');
  assert.truthy(RE.test('AUTO_NAVIGATE:https://saudade.site/guestbook/ 喵呜～'), 'AUTO_NAVIGATE + URL + 中文粘连');
  assert.truthy(RE.test('NAVIGATE:/talk'), 'NAVIGATE 相对路径');
  assert.truthy(RE.test('AUTO_NAVIGATE:/device-console主人'), 'AUTO_NAVIGATE 相对路径粘连');
  assert.truthy(RE.test('SUMMARY:xxx'), 'SUMMARY');
  assert.truthy(RE.test('[System: 你好]'), '[System: 复述');
  assert.truthy(RE.test('System: x'), 'System: 裸前缀');
  assert.truthy(RE.test('SNOW_EFFECT:on'), '幻觉变形 SNOW_EFFECT');
  assert.truthy(RE.test('TOKK_EFFECT:off'), '幻觉变形 TOKK_EFFECT');
  assert.truthy(RE.test('  EFFECT:rain:off'), '行首空白容忍（trim 后的行）');
  assert.truthy(RE.test('AUTO_NAVIGATE:'), '空参数命令');
  assert.truthy(RE.test('NAVIGATE:'), '空参数 NAVIGATE');
  assert.truthy(RE.test('EFFECT:'), '空参数 EFFECT');
  assert.falsy(RE.test('喵呜～EFFECT:sakura'), '非行首命令不匹配（正文引用）');
  assert.falsy(RE.test('好的喵！'), '普通正文不匹配');
  assert.falsy(RE.test('今天天气不错'), '普通正文不匹配');
  assert.truthy(RE.test('EFFECT:sakura 是正文里的说明'), '行首命令头成立 → 匹配（剥段语义由调用方处理）');
  // 命令 + 正文同行剥离语义（stripCommandPrefix 同源）
  const strip = (line) => { let rest = line, m; while ((m = rest.match(RE))) rest = rest.slice(m[0].length); return rest; };
  assert.eq(strip('AUTO_NAVIGATE:https://saudade.site/guestbook/ 喵呜～'), ' 喵呜～', 'URL 后空格处截断（前导空格保留，原行为）');
  assert.eq(strip('AUTO_NAVIGATE:/talk'), '', '相对路径纯命令剥空');
  assert.eq(strip('  EFFECT:sakura:on'), '', '带行首空白的纯命令剥空');
  assert.eq(strip('AUTO_NAVIGATE:/aAUTO_NAVIGATE:/b'), ':/b',
    '粘连双命令：相对路径分支 [\\w-._~/]* 贪婪吞掉第二个前缀（原 RE 语义锚点）');
  assert.eq(strip('喵呜～EFFECT:sakura'), '喵呜～EFFECT:sakura', '非行首命令不动');
  assert.eq(strip('NAVIGATE:https://saudade.site/article/16喵呜'), '喵呜', 'URL 中文边界截断保留正文');
}

console.log('\n== stripMentionSpans（20260920：提及 ≠ 命令）==');
{
  const s = core.stripMentionSpans;
  // 内联代码区：模型讲机制时的举例 —— 必须剥掉，否则 effectMatch 会真的切特效
  const t1 = '系统的 `EFFECT:sakura:on` 只是帧格式，正文里写它不会执行喵';
  assert.falsy(/EFFECT:\s*(\w+)\s*:?\s*(\w+)?/.test(s(t1)), '内联代码里的 EFFECT 被剥掉');
  // 围栏代码块（``` 配对被 `[^`]*` 吃掉内容）
  const t2 = '命令长这样：\n```\nAUTO_NAVIGATE:/talk\n```\n喵～';
  assert.falsy(/AUTO_NAVIGATE/.test(s(t2)), '围栏代码块里的命令被剥掉');
  // 引号区
  const t3 = '我记得“DARKMODE:on”是系统内部的帧格式，不是给人看的';
  assert.falsy(/DARKMODE:\s*(on|off)/.test(s(t3)), '中文引号里的 DARKMODE 被剥掉');
  assert.falsy(/"NAVIGATE:\/talk"/.test(s('他说 "NAVIGATE:/talk" 不算数')), 'ASCII 双引号里的命令被剥掉');
  // 真实命令（无引号无反差）必须原样保留 —— 正文兜底靠的就是它
  const t4 = '好的，AUTO_NAVIGATE:/talk 这就带你去！';
  assert.truthy(/AUTO_NAVIGATE/.test(s(t4)), '裸命令不被剥（正文兜底路径不受影响）');
  assert.eq(s('好的，EFFECT:sakura:on'), '好的，EFFECT:sakura:on', '无跨度文本原样返回');
  // 替换成空格而非空串：防把相邻片段粘出新的假命令
  assert.eq(s('EFFE`x`CT:on'), 'EFFE CT:on', '剥离处补空格（防粘连出新命令）');
  assert.eq(s(''), '', '空串安全');
  assert.eq(s(undefined), '', 'undefined 安全（走 (s||\'\')）');
}

console.log('\n' + '─'.repeat(50));
console.log((failed === 0 ? '✅ 全部通过' : '❌ 有失败') + `：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
