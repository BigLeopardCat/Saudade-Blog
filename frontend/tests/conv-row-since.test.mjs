// ═ 会话列表行「起点标记」回归（20260918 A 方案）══
//   node tests/conv-row-since.test.mjs
// 背景：会话标题只从**首条用户消息**派生一次且不再变，长会话会一直挂着旧标题
//   （现网实例：09-05 开的一句"你都能做些上面"聊到今天共 240 条），而时间是当前
//   → 用户读成"我点开的历史会话被自动更新成了当前时间"。A 方案 = 跨天会话在行内
//   时间后补"9-5 起"，一眼分辨"开了 N 天一直在聊"与"旧会话"。
// 判据重点在**同日零变化**：创建日 = 最后活动日的会话（绝大多数）不加标记，
//   行宽与观感与改动前完全一致；缺字段/脏值也一律不显示，绝不让异常时间冒出"起"。
// 取的是**线上真实源文件**（chat-session.js）里那段纯函数，不是抄一份副本。
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '../public/live2d-widgets/chat-session.js'), 'utf8');

// ── 从真实源里抠出 rowSince 的函数表达式（不复制实现，改了源测试就跟着变）──
const mark = 'const rowSince = ';
const s0 = src.indexOf(mark);
if (s0 < 0) throw new Error('chat-session.js 里找不到 rowSince 定义');
const s1 = src.indexOf('\n    };', s0);
if (s1 < 0) throw new Error('rowSince 定义结尾未找到');
// 切到 "\n    };" 时要把收尾的 "}" 一起带上（只舍去分号），否则函数体不闭合
const rowSince = new Function('return (' + src.slice(s0 + mark.length, s1 + 6) + ');')();

const Y = new Date().getFullYear();
const ms = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi, 0).getTime();

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
};

console.log('rowSince —— 跨天会话补起点：');
// 现网真实一例：09-05 19:45 开、09-18 11:02 最后发言 → "9-5 起"
eq('现网 144（09-05 开 → 今天仍在聊）', rowSince({ created_at: ms(Y, 9, 5, 19, 45), updated_at: ms(Y, 9, 18, 11, 2) }), '9-5 起');
// 跨月但同年
eq('跨月同年（8-31 开 → 9-1）', rowSince({ created_at: ms(Y, 8, 31, 23, 50), updated_at: ms(Y, 9, 1, 0, 10) }), '8-31 起');
// 跨年 → 带年份（否则"12-31 起"会被误读成今年）
eq('跨年（去年 12-31 开 → 今年 1-2）', rowSince({ created_at: ms(Y - 1, 12, 31, 22, 0), updated_at: ms(Y, 1, 2, 9, 0) }), (Y - 1) + '-12-31 起');

console.log('rowSince —— 同日/脏值一律不显示（零变化）：');
eq('同日不同时刻（00:10 开 → 23:00 说）', rowSince({ created_at: ms(Y, 9, 18, 0, 10), updated_at: ms(Y, 9, 18, 23, 0) }), '');
eq('同日同刻', rowSince({ created_at: ms(Y, 9, 5, 19, 45), updated_at: ms(Y, 9, 5, 19, 45) }), '');
eq('created_at 缺字段（undefined）', rowSince({ updated_at: ms(Y, 9, 18, 11, 0) }), '');
eq('updated_at 缺字段', rowSince({ created_at: ms(Y, 9, 5) }), '');
eq('created_at = 0（naive_ms 兜底值）', rowSince({ created_at: 0, updated_at: ms(Y, 9, 18, 11, 0) }), '');
eq('created_at = null', rowSince({ created_at: null, updated_at: ms(Y, 9, 18, 11, 0) }), '');
eq('created_at = NaN', rowSince({ created_at: NaN, updated_at: ms(Y, 9, 18, 11, 0) }), '');
eq('created_at 是字符串数字（类型不符）', rowSince({ created_at: String(ms(Y, 9, 5)), updated_at: ms(Y, 9, 18, 11, 0) }), '');
eq('c 为 null', rowSince(null), '');

console.log('空态文案 —— 指引指向左侧 rail 的 ＋（右上角那枚早已不存在）：');
eq('含正确文案', src.includes('还没有会话，点左侧 ＋ 开始新对话'), true);
eq('无陈旧"点 ＋ 开始新对话"（无方位）', /点\s＋\s开始新对话/.test(src), false);
// rail 新对话按钮确实存在（文案指向的对象不能消失）
eq('rail 有 #conv-new-btn', /id="conv-new-btn"/.test(readFileSync(path.join(here, '../public/live2d-widgets/chat-render.js'), 'utf8')), true);

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
