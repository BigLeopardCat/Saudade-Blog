# -*- coding: utf-8 -*-
"""后台「用户管理」页（账号管理 + 评论管理）的无头验收：真组件 + 真 antd + 假后端。

20260926 这一轮四件事，每件都只有真跑一遍才看得见：

  · **筛选/检索的头不再滚走** —— 这是用户报的症状（"向下滚动会丢失筛选检索的头"）。
    判据是几何：滚列表前后，工具栏那一条的 `rect.top` 一动不动，而行/表头的 top 变了。
    光读 CSS 看不出这个（少写 `min-height: 0`，flex 项的自动最小高度按内容算，
    整块会被内容撑高、自己永远不出滚动条，反而退回"整页滚"——那时两条断言都假过）。
  · **账号列表的角色筛选/检索** —— 判据是**行数**：筛"管理员账号"后留下的行必须
    恰好是 role=admin 的那些，且管理员行不给"删除"按钮。
  · **新建账号框不再被浏览器回填** —— 根因不在缺 `autocomplete`（Chrome 对判定为
    凭据的字段忽略 `off`），而在**页面里常驻着一个密码框**：没有 `<form>` 时 Chrome
    把整页散落的输入框当成一个合成表单，"页面上有密码框"就等于"本页是登录页"。
    所以判据是**页面上密码框的条数**：常态 1 个（新建表单那个）、打开改密弹窗 2 个、
    关掉回到 1 个。这条同时锁住了 `forceRender`（关窗时 children 不更新那个坑）。
  · **评论管理同款内滚动 + 分页条钉底 + 表头吸顶** —— 与文章列表同一套做法。
  · **冻结 / 解冻账号**（同日晚些，第 5 件）—— 判据分三层：行上的「已冻结」标签、
    按钮的**极性**（冻结行上写着"解冻"、未冻结行上写着"冻结"）与**配色**（danger 只给
    "冻结"那一侧）、以及筛"冻结账号"这一档时行的归属会**跟着状态走**。请求侧锁三件事：
    POST 到 `/api/temp-users/<id>/status`、body 传的是**目标状态**而非"切换一下"、
    成功后会重新拉一次列表。另有两条刻意锁住的语义：`status` 缺失按 0 算（部署顺序
    兜底），而 `status = 2` 这种**未登记取值按冻结处理**（与后端 `is_frozen` 同一条）。
    同日晚些再加一层（用户点名「把 OK 换成对应具体事务」）：**冻结/解冻要先弹确认框，
    且确认按钮上的字是这一下的动作词**（「冻结」/「解冻」，不是「确定/OK」；标题、正文
    里的后果说明、danger 极性都跟着方向走）。三条不变量跟着一起锁：弹窗开着时**零请求**、
    点取消**零请求**、只有点确认才发出那一条 POST。
    两个坑写在下面的探针里：antd 的 `autoInsertSpace` 会在两个汉字之间插空格
    （拿到的是「解 冻」——**弹窗确认按钮上同样会**，所以认定文案前一律抹空白），
    以及假响应每次 GET 必须返回**深拷贝**——返回同一个数组
    引用会让 React 的 `Object.is` 直接跳过重渲染，症状是"POST 成功了但行没动"。
  · **超级管理员视角**（第六节）—— 页面上有两个按钮的亮灭取决于"我是谁"：同级
    管理员不可互冻（后端 `check_freeze` 的 PeerAdmin）、不能冻自己（SelfTarget）、
    只有超管看得见「变更身份」。**三条判据各验一次**——混成一条实现（例如"对方是
    管理员就挡"）会在"自己那一行"和"超管看管理员"这两处同时出错，只看一条是看不出来的。
    顺带锁住令牌的两种边界：`sub` 解析出来才知道"哪一行是我"（不再为这件事去拉
    /profile），而令牌解析不出时页面照常渲染、按钮按最保守的界面给（不白屏、不崩）。
  · **账号管理改走共享 axios 客户端**（同日晚些的第 6 件）——六处 `fetch` + 手拼
    `'Bearer ' + token` 全部撤掉。判据是运行时的：`window.__fetchCalls` 恒空
    （`zero_bare_fetch`），而账号请求出现在 `__calls` 里且**请求头**由客户端的
    请求拦截器补（桩只记 url/method/body，头不在记录里——本页锁的是"走没走那条
    通道"，头的事归 `src/apis/axios.tsx` 自己的测试管）。桩的形状也照真后端改：
    GET 回**裸数组**、写接口回 `{code,message,data}`——两半不一致时"把 `res.data`
    写成 `res.data.data`"这类缺陷会被桩掩盖成"没有账号"。
  · **发通知**（第七节，同日晚些的第 7 件）—— 每行一个入口 + 受控弹窗（标题可空、
    正文必填）。四层判据：每行都有入口、**弹窗开着时零请求**、**正文为空时主按钮
    禁用**（且点它真不发请求）、请求体是 `{title, content}` 的**真填值**（标题留空
    原样传空串，默认标题由后端给）。顺带锁两条：关窗后两个输入框从 DOM 摘掉
    （`forceRender` + 条件渲染——本页 20260926 已被 Chrome 的合成表单回填坑过一次），
    以及成功/被拒两侧信息**方位相反**（`data` vs `message`）。

沿用既定手段（本机不能 vite build，见 CLAUDE.md §2）：esbuild 把真组件打成 bundle，
只桩两个边界（`src/apis/axios.tsx` 与 `window.fetch`——20260926 起这一页**整页都走
axios**：账号管理原来六处自拼 `fetch` + `'Bearer ' + token`，已迁到共享客户端，于是
令牌失效时才有那条"清 token + 跳登录"的全局处理）；`window.fetch` 那个桩留着当**哨兵**：
它一旦非空就说明有人把某处改回了裸 fetch（判据见 zero_bare_fetch）。
sass 用 programmatic API 单独编译后用 `--loader:.sass=text` 收下。
本机无中文字体（汉字渲染成豆腐块），断言全走数值与条数。

用法：python3 frontend/tests/users-page.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd/react-router-dom）、playwright(python)。
"""
import functools
import http.server
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

# ── 假后端之一：axios（评论管理用的那个）──────────────────────────────────────
FAKE_AXIOS = r"""
const calls: any[] = (window as any).__calls = [];
(window as any).__axiosStub = true;

// 40 条留言 = 4 页（每页 10）⇒ 分页条真的有多页可翻，"切页"才有意义
const BOARD = Array.from({ length: 40 }, (_, i) => ({
  talkKey: 1000 + i,
  content: '留言 ' + (i + 1),
  cat: ['愿', '寄', '忆', '诉'][i % 4],
  v: i % 3,
  author: '留名人' + (i + 1),
  createTime: '2026-09-2' + (i % 9) + ' 10:00:00',
  userId: 700 + (i % 5),
  username: 'u' + (i % 5),
  nickname: '昵称' + (i % 5),
  approved: i % 3,
  ai_result: i % 2 ? 'pass' : null,
  rejectReason: null,
}));

// 额度重置申请队列（20260929）：三行覆盖**三种状态**（0 待处理 / 1 已批准 / 2 已驳回），
// 于是"只有 status===0 的行给动作"「驳回理由跟在申请理由下面」这两条都验得出来。
// 9001 刻意是 137/500：`额度管理`页签里那一列与账号行上那枚 chip 的判据都是它。
const QUOTA_REQS = [
  { id: 9001, userId: 100, username: 'guest1', nickname: '昵称1', used: 137, limit: 500,
    reason: '想继续问问题', status: 0, note: null,
    createdAt: '2026-09-28 10:00:00', handledAt: null },
  { id: 9002, userId: 101, username: 'guest2', nickname: '昵称2', used: 500, limit: 500,
    reason: '', status: 0, note: null,
    createdAt: '2026-09-28 11:00:00', handledAt: null },
  { id: 9003, userId: 102, username: 'guest3', nickname: '昵称3', used: 90, limit: 500,
    reason: '之前被驳回过', status: 2, note: '短时间内重复申请',
    createdAt: '2026-09-27 09:00:00', handledAt: '2026-09-27 12:00:00' },
];

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
// 裸响应：响应的 body 本身就是 `{code,message,data}` 那一层（账号管理的写接口是
// `utils::ApiResponse`，读接口是裸数组——两种形状都在这一页上，别混）
const env0 = (body: any) => ({ status: 200, data: body });
const wire = (d: any) => (d == null ? d : JSON.parse(JSON.stringify(d)));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ⚠️ 桩必须**同时**是"可调用的函数"和"带方法的对象"——`axios.create()` 出来的实例
// 本来就是这两者的合体，而这一页上的调用方两种写法都有：
//   · 账号管理写的是 `http.get('/api/temp-users')`（方法形态）；
//   · `apis/ProfileMethods.tsx`（个人中心那一族 + 额度管理页签）写的是
//     `http({url, method})`（**直接调用**形态）。
// 只做对象 ⇒ 后者是 TypeError，而组件里 `try{ await http(...) }catch{}` 会把它静静
// 吃掉（只弹一条 message.error、桩里一条记录都没有），症状是"表格空着、零异常"——
// 20260926 在"只做裸函数"那一侧踩过一次，20260929 额度管理页签在**另一侧**又踩了一次
// （挂载超时现场：`.QuotaManage` 在、`.ant-table` 在、行 0、`__calls` 里只有
// `/api/temp-users`）。两侧一起钉住，别只留一边。
const req = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  // `params` 也记下来：额度申请队列那条接口用 `?status=pending|all` 区分只看待处理
  // 还是看全部（判据在**服务端**，不是本地过滤）——不记这一栏就分不清桩到底收到没有。
  calls.push({ url, method, data: wire(cfg.data), params: wire(cfg.params) });
  await delay(20);
  if (url === '/api/protect/board') return env(BOARD);
  if (url === '/api/protected/websetting') return env({ aiReviewEnabled: false, manualReviewEnabled: false });
  // ── 账号管理（20260926 起也走这个客户端；此前它走 window.fetch）────────────
  // ⚠️ GET 回的是**裸数组**，不是 env() 那层 {code,message,data} 壳：真后端
  // `src/routes/temp_user.rs::list_temp_users` 返回的就是 `Json<Vec<TempUserInfo>>`。
  // 桩在这里必须跟真后端一致——否则组件里把 `res.data` 误写成 `res.data.data`
  // 这种缺陷会被桩掩盖成"没有账号"（axios 不报错、页面不红）。
  if (url === '/api/temp-users' && method === 'GET') {
    return { status: 200, data: wire((window as any).__users) };
  }
  // status 这一条要**真改内存里那一行**（同 fetch 桩）：于是"点冻结 ⇒ 它出现在
  // 冻结筛选里"是端到端成立的，而不是靠断言自己骗自己。
  if (/^\/api\/temp-users\/\d+\/status$/.test(url) && method === 'POST') {
    const id = Number(url.split('/')[3]);
    const u = ((window as any).__users as any[]).find((x) => x.id === id);
    const frozen = (cfg.data || {}).frozen === true;
    if (u) u.status = frozen ? 1 : 0;
    // ⚠️ 人类可读的那句在 **data** 里、`message` 恒为字面量 'ok' —— 这是
    // `utils::ApiResponse::success(data)` 的形状（message 写死 "ok"，见 src/utils.rs）。
    // 桩要是把中文句放进 message，组件里 `message.success(res.data.message)` 那种
    // 读错字段的写法就照样绿（用户 20260926 报的"只有一个 ok 的弹窗条"正是这么来的）。
    return env0({ code: 200, message: 'ok',
                  data: frozen ? '账号已冻结，其登录状态已全部失效' : '账号已解冻，请让对方重新登录' });
  }
  // ── 变更身份（20260926）────────────────────────────────────────────────────
  // 与上面 status 那条同一条纪律：**真改内存里那一行**（于是"改完角色标签跟着变"
  // 是端到端成立的），且人类可读的那句在 `data` 里（`message` 恒为字面量 'ok'）。
  // 拒绝那一侧正好相反：`ApiResponse::error` 把原因放在 **message** 里、没有 data
  // ——两个字段的方位在成败两侧是反的，读错任一侧都会弹一个空条或一个 "ok" 条。
  // 用 `__roleDeny` 让桩按需拒绝（验的就是"拒绝时弹的是后端那句原因"）。
  if (/^\/api\/temp-users\/\d+\/role$/.test(url) && method === 'POST') {
    const id = Number(url.split('/')[3]);
    const r = (cfg.data || {}).role;
    const deny = (window as any).__roleDeny;
    if (deny) return env0({ code: 500, message: deny });
    const u = ((window as any).__users as any[]).find((x) => x.id === id);
    if (u) u.role = r;
    const label = ({ admin: '管理员', secretary: '秘书', user: '普通用户' } as any)[r] || r;
    return env0({ code: 200, message: 'ok',
                  data: '身份已改为' + label + '，该账号的登录状态已失效，请让对方重新登录' });
  }
  // ── 发通知（20260926）──────────────────────────────────────────────────────
  // 与 status/role 同两条纪律：**成功那句中文在 `data` 里**（`message` 恒为 'ok'），
  // 而**拒绝那句在 `message` 里**（`ApiResponse::error` 没有 data）——方位在成败
  // 两侧正好相反。用 `__noticeDeny` 让桩按需拒绝（验"被拒时弹的是后端那句原因"）。
  if (/^\/api\/temp-users\/\d+\/notice$/.test(url) && method === 'POST') {
    const deny = (window as any).__noticeDeny;
    if (deny) return env0({ code: 500, message: deny });
    const id = Number(url.split('/')[3]);
    const u = ((window as any).__users as any[]).find((x) => x.id === id);
    return env0({ code: 200, message: 'ok', data: '已把通知发给「' + ((u && u.username) || '') + '」' });
  }
  // ── 主动重置某个账号的额度（20260929）──────────────────────────────────────
  // 与 status/role/notice 同两条纪律（**真改内存里那一行**、成功那句中文在 `data` 里），
  // 外加这一条特有的：**请求没有 body**（后端 handler 只有 State + Path 两个提取器，
  // 同 `/password-reset-token`；前端顺手补个 `{}` 会 422）。所以这里**不去读 `cfg.data`**，
  // 把"到底发了什么 body"整个留给断言去看。
  if (/^\/api\/temp-users\/\d+\/quota-reset$/.test(url) && method === 'POST') {
    const id = Number(url.split('/')[3]);
    const u = ((window as any).__users as any[]).find((x) => x.id === id);
    if (u) u.chatQuotaUsed = 0;
    return env0({ code: 200, message: 'ok',
                  data: '已把账号「' + ((u && u.username) || '') + '」的对话额度恢复到 500 轮' });
  }
  // ── 额度申请队列（20260929）────────────────────────────────────────────────
  // `?status=pending` 只看待处理、其余看全部——**过滤在服务端**（这一页是全局队列，
  // 本地过滤会先被后端的 limit 截一次）。桩照做，于是"切筛选 ⇒ 真的少了一行"是
  // 端到端成立的，而不是断言自己骗自己。
  if (url === '/api/protected/quota/requests' && method === 'GET') {
    const want = (cfg.params || {}).status;
    const rows = want === 'pending' ? QUOTA_REQS.filter((r) => r.status === 0) : QUOTA_REQS;
    return env(wire(rows));
  }
  // 裁决。这一条要**真改内存里那一行**，且改的**不止一行**：批准同时把那个账号的
  // `chatQuotaUsed` 清零了——而回包只带得回一句中文（`data`），一个值都没有。
  // 前端那页的承重取舍正是为此：成功之后**重拉列表**，不做就地更新（见 QuotaManage
  // 文件头注①）。桩按真后端改这两处，`status` 的三值语义也照做（只有 `0 → 1/2`）。
  if (/^\/api\/protected\/quota\/requests\/\d+\/review$/.test(url) && method === 'POST') {
    const id = Number(url.split('/')[5]);
    const row = QUOTA_REQS.find((r) => r.id === id);
    const approved = (cfg.data || {}).approved === true;
    // 原子认领失败那一侧：后端回「这条申请已经处理过了」且**零副作用**
    if (!row || row.status !== 0) return env0({ code: 500, message: '这条申请已经处理过了' });
    row.status = approved ? 1 : 2;
    row.note = approved ? null : ((cfg.data || {}).reason || null);
    row.handledAt = '2026-09-29 12:00:00';
    if (approved) {
      const u = ((window as any).__users as any[]).find((x) => x.id === row.userId);
      if (u) u.chatQuotaUsed = 0;
    }
    // 两句**逐字抄** `src/routes/quota.rs::review_quota_request` 的 `ApiResponse::success`
    // 那一行（人话在 `data` 里，`message` 恒为字面量 "ok"）。这里一度写着带
    // 「额度已清零（N 轮）」的旧文案——那是 20260929 被用户否掉的说法（主人看到的是递减的
    // 余额），而且与真后端不同 ⇒ 沙箱喊的就不是后端那句话。
    return env0({ code: 200, message: 'ok',
                  data: (approved ? '已批准账号「' : '已驳回账号「')
                        + row.username + '」的额度重置申请' });
  }
  // ── 删除账号（20261001）────────────────────────────────────────────────────
  // 这一条要**真把内存里那一行摘掉**：于是"删完那一行从列表里消失、计数从 29 变 28"
  // 是端到端成立的，而不是断言自己骗自己（同 status/role 那两条的纪律）。
  // 回包形状照 `delete_temp_user`：成功那句中文在 **`data`** 里，`message` 恒为 'ok'。
  if (/^\/api\/temp-users\/\d+$/.test(url) && method === 'DELETE') {
    const id = Number(url.split('/')[3]);
    const arr = (window as any).__users as any[];
    const i = arr.findIndex((x) => x.id === id);
    if (i < 0) return env0({ code: 500, message: '用户不存在' });
    arr.splice(i, 1);
    return env0({ code: 200, message: 'ok', data: '用户已删除' });
  }
  return env0({ code: 200, message: 'ok', data: null });
};

const http: any = (cfg: any) => req(cfg);
http.get = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'GET' });
http.post = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'POST' });
http.put = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'PUT' });
http.delete = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'DELETE' });
export default http;
"""

ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Users from './src/pages/Dashboard/Users/index.tsx';

// ── 令牌（20260926）────────────────────────────────────────────────────────
// 这一页此前只有一枚假令牌 `'x.y.z'`（解析不出任何 claims）。现在页面上有**两个
// 按钮的亮灭取决于"我是谁"**（同级管理员不可互冻、只有超管看得见变更身份），
// 再用一枚解析不出的令牌，那两条判据就永远是"没亮"——断言写出来是绿的，
// 却一条都没验到（新功能恒不出现的假绿）。所以改成真形状的 JWT：
// 三段、payload 是 base64url 的 `{sub, role}`，`getRoleFromToken` 认得它。
// 想要"解析不出的令牌"那条路径时用 `__setToken(null)`（仍回旧那枚 'x.y.z'）。
const b64u = (o: any) => btoa(JSON.stringify(o))
  .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
// uid 也要能指定：页面上"不能冻结自己"那条判据读的正是令牌的 `sub`
// （`getUidFromToken`）。默认 sub=1 正好是夹具里那个管理员 root_admin，于是
// "管理员视角下自己那一行"是默认情形；要验**同级**那个分支就把 uid 换成不在
// 名单里的 721（真站点的 admin uid 形状）。
(window as any).__setToken = (role: string | null, uid: number = 1) => {
  localStorage.setItem('tokenKey', role ? 'x.' + b64u({ sub: uid, role }) + '.sig' : 'x.y.z');
};
(window as any).__setToken('admin');   // 默认管理员视角；其它视角在第六节里切

// 账号列表 20260926 起走共享 axios 客户端（桩在 FAKE_AXIOS 里，GET 回裸数组）。
// 下面这个 fetch 桩是**残留的哨兵**：这一页现在一条 fetch 都不该发，桩留着只为
// 「谁把某一处改回裸 fetch」时留下证据（见 zero_bare_fetch）。
// 30 行 ⇒ 账号列表在 700 高的窗口里必然溢出，"只有列表滚"那条断言才不是空转。
// status 与后端 `user.status` 同口径：0=正常 / 1=冻结（取值域见 src/authz.rs）。
// 预置两行冻结（guest27/guest28 = id 126/127）——两行**一个是普通用户**，
// 于是"角色筛选不排除冻结账号"与"冻结筛选只按状态"这两条才验得出来。
// 额度字段（20260929）与后端 `TempUserInfo` 的两个 camelCase 字段同名（`chatQuotaUsed`
// / `chatQuotaLimit`）。三行刻意各不相同，因为它们是**三种不同的事实**，前端那三个
// 分支各对应一个：
//   · root_admin：`chatQuotaLimit === 0` ⇒ **不限额**（管理员档；0 是"不限"而不是
//     "上限为零"）。「重置额度」按钮在这一行必须是**禁用的**（后端也拒）。
//   · guest1（i=0）：137/500 —— 行上那枚 chip 与额度管理页那两列的判据都是它。
//   · guest27（i=26）：**刻意不带这两个字段** —— 那是"前端已上线、后端还没到"的形状，
//     行上要显示「额度 —」而不是 0/0（0/0 会被读成"这个人用完了"）。
const USERS = [
  { id: 1, username: 'root_admin', role: 'admin', status: 0,
    chatQuotaUsed: 0, chatQuotaLimit: 0 },
  ...Array.from({ length: 28 }, (_, i) => ({
    id: 100 + i, username: 'guest' + (i + 1),
    // i===19（guest20）刻意是**杂鱼**：20261002 把改身份下放给管理员之后，
    // 「低两档的行才有入口」这条要有个杂鱼行才测得全（前端 `ADMIN_ROLE_TIERS`
    // 里那两档是 user 与 zako）。它同时是后台行上唯一一枚杂鱼徽章的宿主。
    // 挑 guest20 是因为全文件没有一处引用它，且 `guest1` 前缀检索不会命中它
    // （「guest20」的前六个字符是 guest2）。
    role: i === 19 ? 'zako' : 'user',
    status: i >= 26 ? 1 : 0,
    ...(i === 26 ? {} : { chatQuotaUsed: i === 0 ? 137 : (i * 13) % 500,
                          chatQuotaLimit: 500 }) })),
  { id: 200, username: 'sec_zhang', role: 'secretary', status: 0,
    chatQuotaUsed: 12, chatQuotaLimit: 500 },
];
(window as any).__users = USERS;
(window as any).__fetchCalls = [];

window.fetch = (async (input: any, init: any) => {
  const url = typeof input === 'string' ? input : String(input && input.url);
  const method = String((init && init.method) || 'GET').toUpperCase();
  (window as any).__fetchCalls.push({
    url, method, body: (init && init.body) ? JSON.parse(init.body) : null });
  await new Promise((r) => setTimeout(r, 20));
  let body: any = { code: 200, message: 'ok', data: null };
  // ⚠️ 必须回**深拷贝**，不能把 USERS 本体丢回去：真 HTTP 每次都反序列化出一个新对象，
  // 而这里的 USERS 是同一个数组引用 ⇒ `setTempUsers(data)` 会被 React 的 Object.is
  // 判等拦下、**不触发重渲染**，症状是"改了状态但界面纹丝不动"——20260926 就在这个
  // 坑上误判过一次（同族的坑见上面 axios 桩那条注释）。
  if (url === '/api/temp-users' && method === 'GET') body = JSON.parse(JSON.stringify(USERS));
  else if (/^\/api\/temp-users\/\d+\/status$/.test(url) && method === 'POST') {
    // 真按请求体改内存里那一行 —— 于是"点冻结 ⇒ 它出现在冻结筛选里"是
    // 端到端成立的，而不是靠断言自己骗自己
    const id = Number(url.split('/')[3]);
    const u = USERS.find((x) => x.id === id);
    const frozen = (init && init.body) ? JSON.parse(init.body).frozen === true : false;
    if (u) u.status = frozen ? 1 : 0;
    body = { code: 200, message: 'ok',
             data: frozen ? '账号已冻结，其登录状态已全部失效' : '账号已解冻，请让对方重新登录' };
  }
  return { ok: true, status: 200, json: async () => body } as any;
}) as any;

(window as any).__mount = (path: string) => createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/dashboard/users" element={<Users />} />
    </Routes>
  </MemoryRouter>
);
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="users-ui-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    sass_files = ["src/pages/Dashboard/Users/index.sass",
                  "src/pages/Dashboard/BoardManage/index.sass",
                  # 额度管理页签（20260929）：它自己那份 .sass 也要编译进来——不编译
                  # 就是"样式静默失效"（页面上那三段固定壳/内滚动全部塌成内容高度），
                  # 而几何断言会把它读成"页面缺陷"。同 BoardManage 那条。
                  "src/pages/Dashboard/QuotaManage/index.sass"]
    css = []
    for rel in sass_files:
        out = sb / (pathlib.Path(rel).stem + ".css")
        subprocess.run(["node", "-e",
                        "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                        "require('fs').writeFileSync(process.argv[2],r.css);",
                        str(FE / rel), str(out)], cwd=str(FE), check=True)
        css.append(out.read_text())

    # 全站样式表：`src/main.tsx` 第一行就 import 它，所有页面都吃得到（`.counter-room` 那条
    # 给 showCount 计数腾地方的规则就住在里面）。沙箱此前只编译上面那几份 .sass ⇒ 全局规则
    # 在沙箱里根本不存在，几何断言会把"规则没生效"读成"页面缺陷"。真站有它，沙箱就得有它。
    css.append((sb / "src/index.css").read_text())

    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                        "--bundle", "--format=iife", "--outfile=bundle.js",
                        "--loader:.sass=text", "--jsx=automatic",
                        f"--define:{DEFINE}"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))

    # 给页面一个真实的高度上下文：这页的内滚动全靠 height:100% 那条链
    # （真实环境里那一 100% 来自后台壳的 .Card 95% → .ant-card-body 100%），
    # 沙箱只挂一个裸组件、没有父高度可继承 ⇒ 内滚动退化成内容高，断言全空转。
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<style>html,body,#root{height:100%;margin:0}'
        # 真站在 frontend/src/frontHome/main.css 里有一条全局 `*{box-sizing:border-box}`，
        # 后台页面同样吃它。沙箱**必须**照搬：少了它，`.tu-section{height:100%;padding:12px}`
        # 会按 content-box 算（内容高 100% + 上下 padding 溢出容器 24px），
        # "列表区铺到卡片底部"那条断言就会在沙箱里假红——那是沙箱失真，不是页面缺陷。
        '*{box-sizing:border-box;margin:0;padding:0}</style>'
        '<style>' + "\n".join(css) + '</style></head><body><div id="root"></div>'
        '<script src="bundle.js"></script></body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
class _Quiet(http.server.SimpleHTTPRequestHandler):
    """静音：访问日志会落进 ~/sandbox_regression.log（那是给人看断言的地方）。
    必须子类覆写——`partial` 的实例属性不影响它转发的那个类，写成
    `_handler.log_message = lambda …` 等于没写。"""

    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(SANDBOX))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

URL = f"http://127.0.0.1:{_server.server_address[1]}/index.html"


def mount(br, path="/dashboard/users", size=(1440, 700), wait=".tu-row",
          role="admin", uid=1):
    """挂载页面。`role`/`uid` 写进令牌（页面据它决定按钮亮不亮），默认 = 管理员本人
    （uid 1 就是夹具里那个 root_admin）。⚠️ localStorage 是按源的、同一个浏览器上下文
    里跨页面共享 ⇒ **每次 goto 后必须显式重设**，否则上一节切过的超管视角会漏到下一节
    （宿主的假绿：一节验超管、剩下的全在超管视角下跑而没人发现）。"""
    page = br.new_page(viewport={"width": size[0], "height": size[1]})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL)
    page.evaluate("([r, u]) => window.__setToken(r, u)", [role, uid])
    page.evaluate("(p) => window.__mount(p)", path)
    try:
        page.wait_for_selector(wait, timeout=10000)
    except Exception:
        # 等不到就别只说"超时"——把关键节点、几何、请求记录和页面异常一起打出来
        print("  ⚠ 等不到 " + wait + "，现场：")
        print("    " + page.evaluate("""() => {
            const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
                return [Math.round(b.width), Math.round(b.height)]; };
            return JSON.stringify({
                board: R(document.querySelector('.BoardManage')),
                scroll: R(document.querySelector('.bm-scroll')),
                table: R(document.querySelector('.ant-table')),
                rows: document.querySelectorAll('.ant-table-row').length,
                empty: !!document.querySelector('.ant-empty'),
                activePane: (document.querySelector('.ant-tabs-tabpane-active') || {}).className || '',
                axios: (window.__calls || []).map((c) => c.url),
                axiosStub: window.__axiosStub === true,
                // 20260926 起账号管理也走 axios ⇒ 这一栏正常是空的（唯一用途是
                // "谁又偷偷用回裸 fetch 了"）——留着正是为了等不到元素时能一眼看出
                fetch: (window.__fetchCalls || []).map((c) => c.url + '/' + c.method),
            }); }"""))
        print("    页面异常：" + ("; ".join(errs[:3]) or "（无）"))
        raise
    # 页面里 loadTempUsers 是 setTimeout 500ms 后才发的
    page.wait_for_timeout(800)
    page.errs = errs
    return page


GEO = """() => {
    const R = (el) => { const b = el.getBoundingClientRect();
        return {t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), h: +b.height.toFixed(1)}; };
    const q = (s) => document.querySelector(s);
    const pw = [...document.querySelectorAll('input')].filter((i) => i.type === 'password');
    return {
        root: R(document.getElementById('root')),
        section: q('.tu-section') ? R(q('.tu-section')) : null,
        head: q('.tu-head') ? R(q('.tu-head')) : null,
        filter: q('.tu-filter') ? R(q('.tu-filter')) : null,
        wrap: q('.tu-list-wrap') ? R(q('.tu-list-wrap')) : null,
        sectionOverflow: q('.tu-section') ? getComputedStyle(q('.tu-section')).overflowY : '',
        wrapOverflow: q('.tu-list-wrap') ? getComputedStyle(q('.tu-list-wrap')).overflowY : '',
        wrapScroll: q('.tu-list-wrap') ? {sh: q('.tu-list-wrap').scrollHeight, ch: q('.tu-list-wrap').clientHeight} : null,
        rows: document.querySelectorAll('.tu-row').length,
        // 密码框条数：只数**可见**的没意义（关闭的弹窗是 display:none 但仍在 DOM 里，
        // 而"留在 DOM 里"正是浏览器判定本页为登录页的充分条件）
        pwCount: pw.length,
        pwInCreate: pw.filter((i) => i.closest('.tu-create')).length,
        pwElsewhere: pw.filter((i) => !i.closest('.tu-create')).length,
        modalWrap: document.querySelectorAll('.ant-modal-wrap').length,
        count: q('.tu-count') ? q('.tu-count').textContent : '',
        // 每行的按钮按**类名**取，不按 .ant-btn-dangerous 取（20260926）：
        // 「冻结」在未冻结行上也是 danger，按危险色取会把它当成删除按钮。
        delBtns: [...document.querySelectorAll('.tu-row')].map(
            (r) => ({ u: r.querySelector('strong').textContent, del: !!r.querySelector('.tu-del-btn') })),
        freezeBtns: [...document.querySelectorAll('.tu-row')].map((r) => {
            const b = r.querySelector('.tu-freeze-btn');
            // antd 会在两个汉字之间插一个空格（autoInsertSpace）⇒ "解 冻"。
            // 断言前把空白抹掉，否则判的是 antd 的排版而不是我们的文案。
            return { u: r.querySelector('strong').textContent,
                     label: b ? b.textContent.replace(/\s+/g, '') : '',
                     danger: b ? b.classList.contains('ant-btn-dangerous') : false,
                     // 按钮**亮不亮**：同级管理员不可互冻、以及不能冻自己，都由它体现
                     disabled: b ? b.disabled : null,
                     tag: r.textContent.includes('已冻结') };
        }),
        // 发通知（20260926）：每一行都该有一个（收件人是不是可发由后端判，
        // 这一页不按角色分流）
        notifyBtns: [...document.querySelectorAll('.tu-row')].map(
            (r) => ({ u: r.querySelector('strong').textContent,
                      has: !!r.querySelector('.tu-notify-btn') })),
        // 「变更身份」入口：超管每行都有，管理员**只在低两档的行上**有
        // （20261002 下放；不是禁用——够不着的行根本没有这颗按钮）。
        // 行角色从徽章的 data-role 读：**普通用户那档不渲染徽章**（既有规则），
        // 所以读不到就按 'user' 算——这正是界面上那条规则本身。
        roleBtns: [...document.querySelectorAll('.tu-row')].map(
            (r) => ({ u: r.querySelector('strong').textContent,
                      role: (r.querySelector('[data-role]') || { dataset: {} }).dataset.role || 'user',
                      has: !!r.querySelector('.tu-role-btn') })),
        // 行上的身份徽章（改身份之后要能看见它跟着变）。20261002 起这是
        // `RoleBadge`（整枚内联 SVG），**不再是 `.ant-tag`**：
        //   · 取 `[data-role]` 的 `aria-label`——里面是干净的身份名；
        //   · 不读 textContent：SVG `<text>` 里是**逐字加空格**的「管 理 员」，
        //     而且「已冻结」那枚仍是 antd Tag（两个不同来路的东西混在一个夹具里，
        //     改天谁多挂一枚标签就会让断言读到一个拼接串）。
        roleTags: [...document.querySelectorAll('.tu-row')].map(
            (r) => ({ u: r.querySelector('strong').textContent,
                      tag: (r.querySelector('[data-role]') || {getAttribute: () => ''})
                          .getAttribute('aria-label') || '' })),
    };
}"""


# 冻结/解冻的确认框（20260926 用户点名：「把 OK 换成对应具体事务」）。
# 取的是**弹窗页脚**那个按钮，不是行上那个同名的——两者文案一样（冻结/解冻），
# 只有作用域能区分（行上 `.tu-freeze-btn` / 弹窗 `.tu-status-ok`）。
# 按类名认弹窗而不是按 `title` 认：这一页同时挂着三个 `.ant-modal-wrap`
# （改密码、恢复码、本框），关着的那些是 display:none 但仍在 DOM 里。
STATUS_DIALOG = """() => {
    const m = [...document.querySelectorAll('.ant-modal-wrap')].find(
        (w) => getComputedStyle(w).display !== 'none' && w.querySelector('.tu-status-ok'));
    if (!m) return null;
    const q = (s) => (m.querySelector(s) ? m.querySelector(s).textContent.replace(/\\s+/g, '') : '');
    const ok = m.querySelector('.tu-status-ok');
    return {
        title: q('.ant-modal-title'),
        ok: ok.textContent.replace(/\\s+/g, ''),
        okDanger: ok.classList.contains('ant-btn-dangerous'),
        body: q('.ant-modal-body'),
    };
}"""


# 删除账号的确认框（20261001）：与上面两支同形，按类名认（`.tu-del-ok`）。
DEL_DIALOG = """() => {
    const m = [...document.querySelectorAll('.ant-modal-wrap')].find(
        (w) => getComputedStyle(w).display !== 'none' && w.querySelector('.tu-del-ok'));
    if (!m) return null;
    const q = (s) => (m.querySelector(s) ? m.querySelector(s).textContent.replace(/\\s+/g, '') : '');
    const ok = m.querySelector('.tu-del-ok');
    return {
        title: q('.ant-modal-title'),
        ok: ok.textContent.replace(/\\s+/g, ''),
        okDanger: ok.classList.contains('ant-btn-dangerous'),
        body: q('.ant-modal-body'),
    };
}"""


# 变更身份的确认框：与 STATUS_DIALOG 同形，按类名认（`.tu-role-ok`）。
ROLE_DIALOG = """() => {
    const m = [...document.querySelectorAll('.ant-modal-wrap')].find(
        (w) => getComputedStyle(w).display !== 'none' && w.querySelector('.tu-role-ok'));
    if (!m) return null;
    const q = (s) => (m.querySelector(s) ? m.querySelector(s).textContent.replace(/\\s+/g, '') : '');
    const ok = m.querySelector('.tu-role-ok');
    return {
        title: q('.ant-modal-title'),
        ok: ok.textContent.replace(/\\s+/g, ''),
        okDanger: ok.classList.contains('ant-btn-dangerous'),
        body: q('.ant-modal-body'),
    };
}"""


# 发通知的弹窗（20260926）：与 STATUS_DIALOG/ROLE_DIALOG 同形，按类名认
# （`.tu-notify-ok`）。额外取**两个输入框里现有的值**——"预设/校验"这类行为
# 只有真读 DOM 才知道，光看请求体分不清"填对了"和"凑巧传对了"。
NOTIFY_DIALOG = """() => {
    const m = [...document.querySelectorAll('.ant-modal-wrap')].find(
        (w) => getComputedStyle(w).display !== 'none' && w.querySelector('.tu-notify-ok'));
    if (!m) return null;
    const q = (s) => (m.querySelector(s) ? m.querySelector(s).textContent.replace(/\\s+/g, '') : '');
    const ok = m.querySelector('.tu-notify-ok');
    const val = (s) => { const e = m.querySelector(s); return e ? e.value : null; };
    return {
        title: q('.ant-modal-title'),
        ok: ok.textContent.replace(/\\s+/g, ''),
        okDisabled: ok.disabled,
        body: q('.ant-modal-body'),
        // 标题框是裸 `<input>`（`.tu-notify-title` 就落在它身上）；
        // 正文**不能**按 `.tu-notify-body` 找输入框——`showCount` 会把它包进一个
        // `<span class="ant-input-textarea-affix-wrapper … tu-notify-body">`，
        // 类名落在那个 span 上（`fill('.tu-notify-body')` 会报
        // "Element is not an <input>, <textarea>…"）。所以正文一律按
        // `.tu-notify-body textarea` 取。两个断言分开写，免得一个选择器写宽了
        // 把另一个的失败一起盖住。
        fieldsPresent: !!m.querySelector('.tu-notify-title')
            && !!m.querySelector('.tu-notify-body textarea'),
        titleVal: val('.tu-notify-title'),
        contentVal: val('.tu-notify-body textarea'),
    };
}"""


def notice_posts(pg):
    """本页发出的发通知请求（POST …/notice）。与 status_posts 同一条纪律：
    "确认之前一条都不许发""请求体里是真填的那些字"都靠它。"""
    return pg.evaluate("""() => window.__calls.filter((c) =>
        c.method === 'POST' && /\\/notice$/.test(c.url))
        .map((c) => ({ url: c.url, body: c.data }))""")


def role_posts(pg):
    """本页发出的改身份请求（POST …/role）——与 status_posts 同一条纪律：
    "确认之前一条都不许发"「请求体是目标身份而不是让后端取反」都靠它。"""
    return pg.evaluate("""() => window.__calls.filter((c) =>
        c.method === 'POST' && /\\/role$/.test(c.url))
        .map((c) => ({ url: c.url, body: c.data }))""")


# ── 额度（20260929）──────────────────────────────────────────────────────────
# 主动重置的确认框：与 STATUS_DIALOG/ROLE_DIALOG/NOTIFY_DIALOG 同形，按类名认
# （`.tu-quota-ok`）。这一处的正文要把两件事说清（清零后他立刻能问；界面上撤不回来），
# 所以连正文一起取出来——文案是这一族里唯一没有别的判据的东西。
QUOTA_RESET_DIALOG = """() => {
    const m = [...document.querySelectorAll('.ant-modal-wrap')].find(
        (w) => getComputedStyle(w).display !== 'none' && w.querySelector('.tu-quota-ok'));
    if (!m) return null;
    const q = (s) => (m.querySelector(s) ? m.querySelector(s).textContent.replace(/\\s+/g, '') : '');
    const ok = m.querySelector('.tu-quota-ok');
    return {
        title: q('.ant-modal-title'),
        ok: ok.textContent.replace(/\\s+/g, ''),
        okDanger: ok.classList.contains('ant-btn-dangerous'),
        body: q('.ant-modal-body'),
    };
}"""

# 裁决确认框（额度管理页签）。两个弹窗**各按自己主按钮上的类名认**（`.qm-approve-ok`
# / `.qm-reject-ok`），不按标题、也不按 `.ant-modal-wrap` 的序：
# 同页同时挂着两个 `.ant-modal-wrap`，关着的那些 display:none 但仍在 DOM 里——不按
# 可见性过滤就会取到上一个弹窗（这一页开过几次就有几份），断言从此分不清是谁的。
QUOTA_APPROVE_DIALOG = """() => {
    const m = [...document.querySelectorAll('.ant-modal-wrap')].find(
        (w) => getComputedStyle(w).display !== 'none' && w.querySelector('.qm-approve-ok'));
    if (!m) return null;
    const q = (s) => (m.querySelector(s) ? m.querySelector(s).textContent.replace(/\\s+/g, '') : '');
    const ok = m.querySelector('.qm-approve-ok');
    return {
        title: q('.ant-modal-title'),
        body: q('.ant-modal-body'),
        ok: ok.textContent.replace(/\\s+/g, ''),
        okDisabled: ok.disabled,
    };
}"""

QUOTA_REJECT_DIALOG = """() => {
    const m = [...document.querySelectorAll('.ant-modal-wrap')].find(
        (w) => getComputedStyle(w).display !== 'none' && w.querySelector('.qm-reject-ok'));
    if (!m) return null;
    const q = (s) => (m.querySelector(s) ? m.querySelector(s).textContent.replace(/\\s+/g, '') : '');
    const ok = m.querySelector('.qm-reject-ok');
    const ta = m.querySelector('textarea');
    return {
        title: q('.ant-modal-title'),
        tip: q('.qm-reject-tip'),
        presets: [...m.querySelectorAll('.qm-reject-preset')]
            .map((b) => b.textContent.replace(/\\s+/g, '')),
        ok: ok.textContent.replace(/\\s+/g, ''),
        okDisabled: ok.disabled,
        okDanger: ok.classList.contains('ant-btn-dangerous'),
        value: ta ? ta.value : null,
        // `rootClassName` 必须落在**正文的祖先**上，否则 index.sass 里那两条嵌套规则
        // （`.qm-reject-modal .qm-reject-tip` / `.qm-reject-presets`）一条都匹配不上，
        // 样式静默失效而断言全绿——那正是"人工同步"那一族里最难发现的一种。
        rootOk: !!m.closest('.qm-reject-modal'),
    };
}"""


def quota_posts(pg):
    """本页发出的**主动**重置请求（POST …/quota-reset）。与 status_posts 同形，
    外加这一条特有的：把 `body` 原样带出来，判据是**它必须是空的**——后端那个
    handler 只有 State + Path 两个提取器（同 `/password-reset-token`），前端顺手
    补一个 `{}` 会 422。"""
    return pg.evaluate("""() => window.__calls.filter((c) =>
        c.method === 'POST' && /\\/quota-reset$/.test(c.url))
        .map((c) => ({ url: c.url, body: c.data }))""")


def quota_review_posts(pg):
    """额度管理页签发出的裁决请求（POST …/requests/:id/review）。
    `body.approved` 与 `body.reason` 是断言的全部：批准恒不带理由、驳回必带。"""
    return pg.evaluate("""() => window.__calls.filter((c) =>
        c.method === 'POST' && /\\/quota\\/requests\\/\\d+\\/review$/.test(c.url))
        .map((c) => ({ url: c.url, body: c.data }))""")


def quota_requests(pg):
    """额度申请队列那几条 GET 的 `params`（判"只看待处理"是不是真交给服务端：
    桩按 `status=pending` 过滤，所以切筛选之后行数真的会变）。"""
    return pg.evaluate("""() => window.__calls.filter((c) =>
        c.method === 'GET' && c.url === '/api/protected/quota/requests')
        .map((c) => c.params || {})""")


def quota_chips(pg):
    """账号行上那枚额度 chip：`{账号: 文案}`（空白抹掉——antd 的排版不该进断言）。"""
    return pg.evaluate("""() => Object.fromEntries(
        [...document.querySelectorAll('.tu-row')].map((r) => {
            const u = r.querySelector('strong');
            const q = r.querySelector('.tu-quota');
            return [u ? u.textContent : '?', q ? q.textContent.replace(/\\s+/g, '') : '']; }))""")


def quota_btns(pg):
    """每行「重置额度」按钮的亮灭：`{账号: 是否禁用}`。不限额那一行（管理员档）必须
    是禁用的——后端也拒，但让按钮干脆不亮比"点了才被告知"更清楚（与"非普通账号不给
    删除按钮"同一条纪律）。"""
    return pg.evaluate("""() => Object.fromEntries(
        [...document.querySelectorAll('.tu-row')].map((r) => {
            const u = r.querySelector('strong');
            const b = r.querySelector('.tu-quota-btn');
            return [u ? u.textContent : '?', b ? b.disabled : null]; }))""")


def quota_rows(pg):
    """额度管理页签里每一行的文案（空白抹掉，按行取整块文本）。"""
    return pg.evaluate("""() => [...document.querySelectorAll('.qm-scroll .ant-table-row')]
        .map((r) => r.textContent.replace(/\\s+/g, ''))""")


def menu_items(pg):
    """当前**打开着**的那个下拉菜单的选项文案。
    `:visible` 不是可选的美化：antd 关菜单时只是把它藏起来（DOM 留着），这一页开过
    几次就有几份菜单——不限定可见的那个，取到的是历次菜单的并集，
    `pg.locator(...).click()` 还会因为"匹配到 2 个元素"直接 strict-mode 报错。"""
    return pg.evaluate("""() => [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .filter((e) => e.offsetParent !== null)
        .map((e) => e.textContent.replace(/\\s+/g, ''))""")


def click_menu_item(pg, label):
    """点当前打开着的菜单里的一项（同上，必须限定可见的那一份）。"""
    pg.locator(".ant-dropdown-menu-item:visible", has_text=label).first.click()


def tooltips(pg, selector):
    """悬停某个元素之后屏上的 tooltip 文案（antd 渲染到 body 上的 portal 里，
    只有悬停过才会挂出来）。**每个页面只该调用一次**：调第二次会因为前一个
    tooltip 仍留在 DOM 里而拿到两条，断言就分不清是哪一条的文案了。
    用 `force=True`：目标是个 disabled 按钮，playwright 的可操作性检查会拦。"""
    pg.locator(selector).hover(force=True)
    pg.wait_for_timeout(400)
    return pg.evaluate("""() => [...document.querySelectorAll('.ant-tooltip-inner')]
        .map((e) => e.textContent.replace(/\\s+/g, ''))""")


def status_posts(pg):
    """本页发出的状态请求条数（POST …/status）。断言"确认之前一个都不许发"用它。

    20260926 起账号管理走共享 axios 客户端 ⇒ 记录在 `__calls`（原来在 `__fetchCalls`）。
    记录里请求体那一栏两个桩叫法不同（fetch 桩叫 `body`、axios 桩叫 `data`），这里
    统一成 `body`——断言只该关心"发了什么"，不该关心它走的是哪个桩。"""
    return pg.evaluate("""() => window.__calls.filter((c) =>
        c.method === 'POST' && /\\/status$/.test(c.url))
        .map((c) => ({ url: c.url, body: c.data }))""")


def zero_bare_fetch(pg):
    """这一页**一条裸 `fetch` 都不该有**（20260926 迁移的回归锁）。

    `window.fetch` 的桩还在（见 ENTRY），但它现在只该是空的：账号管理原来六处都
    自己 fetch + 手拼 `'Bearer ' + token`，于是绕过了共享客户端的 401 处理。
    谁把某一处改回 fetch，这条立刻红——而不是等到"令牌过期时后台不跳登录"那天。"""
    return pg.evaluate("() => window.__fetchCalls.map((c) => c.method + ' ' + c.url)")


def notices(pg):
    """当前屏上的 antd message 文案（抹空白——antd 会在两个汉字间插空格）。

    冻结/解冻那一侧的判据：后端把人类可读的那句放在 **`data`**、`message` 恒为
    `"ok"`，所以"弹的是不是那句中文"这件事只有真看 DOM 才知道（用户 20260926
    报的就是这里弹了一个只有「ok」的条）。"""
    return pg.evaluate("""() => [...document.querySelectorAll('.ant-message-notice-content')]
        .map((e) => e.textContent.replace(/\\s+/g, ''))""")


with sync_playwright() as p:
    br = p.chromium.launch()
    # ── 一、账号管理：固定壳 + 只有列表滚 ─────────────────────────────────────
    # 用户报的原始症状就在这里（"文章列表的逻辑"）。判据取"头不动、行动"这一对：
    # 只看"列表能滚"是假绿——整页滚的时候列表**也**能滚。
    print("\n【一】账号管理：筛选检索的头固定，只有账号列表在窗口内滚")
    pg = mount(br)
    g0 = pg.evaluate(GEO)
    check("账号列表渲染出来了（30 个账号）", g0["rows"] == 30, f'rows={g0["rows"]}')
    check("前置：列表内容真的溢出了（否则下面两条是空转）",
          g0["wrapScroll"]["sh"] > g0["wrapScroll"]["ch"] + 40,
          f'{g0["wrapScroll"]["sh"]} vs {g0["wrapScroll"]["ch"]}')
    check("整块不再自己滚（.tu-section overflow-y: hidden）",
          g0["sectionOverflow"] == "hidden", g0["sectionOverflow"])
    check("滚动落在列表区上（.tu-list-wrap overflow-y: auto）",
          g0["wrapOverflow"] == "auto", g0["wrapOverflow"])
    # 判"下方没有多余的空白"而不是"完全贴合"：`.tu-section` 自己有 12px 下内边距
    # （收尾的呼吸位，刻意留的），所以列表底比卡片底高 12px 是**设计**。
    # 要紧的是那个差不能更大——差到几十上百 px 就是内容没铺满。
    gap = g0["root"]["b"] - g0["wrap"]["b"]
    check("列表区铺到卡片底部（下方只留容器那 12px 内边距，没有多余空白）",
          0 <= gap <= 16, f'列表底 {g0["wrap"]["b"]} / 卡片底 {g0["root"]["b"]}（差 {gap:.1f}px）')

    # 结构判据（比"滚一下看看头动没动"更硬）：从账号行往上，可滚祖先**只能有一个**，
    # 而且必须是列表区。老代码是整块 .tu-section 自己滚 —— 那时"滚一下头会不会动"
    # 取决于**滚的是谁**（滚列表区它当然不动），所以光靠上面那对断言拦不住回退；
    # 这一条是"筛选那一条在结构上就滚不走"，不依赖测试脚本滚哪个元素。
    scrollers = pg.evaluate("""() => {
        const row = document.querySelector('.tu-row');
        const out = [];
        for (let el = row.parentElement; el; el = el.parentElement) {
            const oy = getComputedStyle(el).overflowY;
            if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
                out.push(el.className || el.tagName);
            }
        }
        return out;
    }""")
    check("从账号行往上只有 .tu-list-wrap 一个可滚祖先（筛选那一条结构上就滚不走）",
          len(scrollers) == 1 and 'tu-list-wrap' in scrollers[0], str(scrollers))

    moved = pg.evaluate("""() => {
        const wrap = document.querySelector('.tu-list-wrap');
        const head = document.querySelector('.tu-head');
        const row0 = document.querySelector('.tu-row');
        const before = { headTop: head.getBoundingClientRect().top, rowTop: row0.getBoundingClientRect().top };
        wrap.scrollTop = wrap.scrollHeight;
        const after = { headTop: head.getBoundingClientRect().top, rowTop: row0.getBoundingClientRect().top,
                        scrolled: wrap.scrollTop };
        return { before, after };
    }""")
    check("滚到底：筛选/检索那一条**一动不动**",
          abs(moved["after"]["headTop"] - moved["before"]["headTop"]) < 1,
          f'{moved["before"]["headTop"]} → {moved["after"]["headTop"]}')
    check("滚到底：账号行确实滚上去了（说明上一条不是「没滚成」）",
          moved["after"]["rowTop"] < moved["before"]["rowTop"] - 100,
          f'{moved["before"]["rowTop"]} → {moved["after"]["rowTop"]}（scrollTop={moved["after"]["scrolled"]}）')
    check("第一节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 二、角色筛选 + 用户名检索 ─────────────────────────────────────────────
    print("\n【二】账号管理的角色筛选与检索")
    pg = mount(br)
    n_all = pg.evaluate("() => document.querySelectorAll('.tu-row').length")
    check("默认「全部」= 30 个账号（管理员也在里面，不再只列普通账号）",
          n_all == 30 and "共 30 个账号" in pg.evaluate(GEO)["count"], f'{n_all} / {pg.evaluate(GEO)["count"]}')

    pg.locator(".tu-tabs button", has_text="管理员账号").first.click()
    pg.wait_for_timeout(200)
    g = pg.evaluate(GEO)
    admins = [r["u"] for r in g["delBtns"]]
    check("筛「管理员账号」：只剩 admin 那一行", admins == ["root_admin"], str(admins))
    check("计数跟着筛（共 1 个账号）", "共 1 个账号" in g["count"], g["count"])
    check("管理员行**没有**删除按钮（后端也拒，见 delete_temp_user）",
          all(not r["del"] for r in g["delBtns"]), str(g["delBtns"]))

    pg.locator(".tu-tabs button", has_text="普通用户账号").first.click()
    pg.wait_for_timeout(200)
    g = pg.evaluate(GEO)
    names = [r["u"] for r in g["delBtns"]]
    check("筛「普通用户账号」：管理员被排除、秘书也在这一档（非管理员）",
          "root_admin" not in names and "sec_zhang" in names and len(names) == 29,
          f'{len(names)} 行，含秘书={"sec_zhang" in names}')
    # 删除按钮只给**普通用户**那一档（后端 `delete_temp_user` 也这么判：秘书与杂鱼
    # 都拒，理由是"该账号不是普通用户，不能在这里删除"）。夹具里非普通用户的就两行：
    # sec_zhang 与 guest20（20261002 起是杂鱼）——两个都要没有，只挑一个验就漏一半。
    check("普通账号行**有**删除按钮（秘书与杂鱼都不是普通用户，同样没有）",
          all(r["del"] for r in g["delBtns"] if r["u"] not in ("sec_zhang", "guest20"))
          and not any(r["del"] for r in g["delBtns"] if r["u"] in ("sec_zhang", "guest20")),
          str([r["u"] for r in g["delBtns"] if not r["del"]]))

    pg.locator(".tu-tabs button", has_text="全部").first.click()
    pg.wait_for_timeout(200)
    pg.locator(".tu-filter .ant-input").first.fill("guest1")
    pg.wait_for_timeout(300)
    g = pg.evaluate(GEO)
    names = [r["u"] for r in g["delBtns"]]
    # guest1 / guest10..guest19 —— 前缀匹配，共 11 个
    check("检索 guest1：命中 11 个（guest1 + guest10..19）", len(names) == 11, str(names))
    check("检索结果里没有不匹配的账号", all(n.startswith("guest1") for n in names), str(names[:5]))
    check("筛不到时显示「没有匹配的账号」而不是「暂无账号」",
          pg.evaluate("""() => { const f = document.querySelector('.tu-filter .ant-input');
                        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                        set.call(f, 'zzz-nobody'); f.dispatchEvent(new Event('input', {bubbles: true}));
                        return document.querySelector('.tu-empty') ? document.querySelector('.tu-empty').textContent : ''; }""")
          .find("没有匹配") >= 0)
    check("检索/筛选**不发新请求**（只筛本地已有的那份）",
          pg.evaluate("() => window.__calls.filter(c => c.method === 'GET').length") == 1,
          str(pg.evaluate("() => window.__calls")))
    # ID 检索（20260926 用户点名）：行上一直显示着 `ID: N`，但检索框只认用户名——
    # 拿着一个 ID 来查（工单/日志里通常只有 ID）永远查不到。判据与用户名同一套（子串），
    # 所以 `10` 会同时命中 ID 100..109 与 ID 210 之外的用户名含 10 的行。
    pg.locator(".tu-filter .ant-input").first.fill("126")
    pg.wait_for_timeout(300)
    g = pg.evaluate(GEO)
    check("检索 126（ID）命中的是 id=126 那一行（guest27）",
          any(r["u"] == "guest27" for r in g["delBtns"]), str([r["u"] for r in g["delBtns"]]))
    check("而且只剩那一行（126 是个子串判据，正好只此一行匹配）",
          [r["u"] for r in g["delBtns"]] == ["guest27"], str([r["u"] for r in g["delBtns"]]))
    pg.locator(".tu-filter .ant-input").first.fill("")
    pg.wait_for_timeout(200)
    # 迁移锁（20260926）：这一页从"六处裸 fetch + 手拼 Bearer"改成走共享 axios 客户端，
    # 判据不是"代码里没有 fetch 这个词"，而是**运行时一条都没发出去**。
    check("账号管理不再走裸 fetch（一条都没有）", zero_bare_fetch(pg) == [],
          str(zero_bare_fetch(pg)))
    check("第二节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 三、密码框摘挂（浏览器回填的根因）──────────────────────────────────────
    # Chrome 的规则：判定为凭据的字段忽略 `autocomplete="off"`；页面没有 `<form>` 时
    # 它把整页散落的输入框当成一个**合成表单**——于是"页面上常驻一个密码框"就等于
    # "本页是登录页"，它便去回填页面上最裸的文本框（这里就是新建账号那两格）。
    # 触发器只有一个：那个常驻的改密弹窗。这条锁的就是它。
    print("\n【三】新建账号框不再被浏览器回填（根因：常驻密码框已摘挂）")
    pg = mount(br)
    g = pg.evaluate(GEO)
    check("前置：改密弹窗是常驻挂载的（forceRender 生效，wrap 在 DOM 里）",
          g["modalWrap"] >= 1, f'modalWrap={g["modalWrap"]}')
    check("常态：全页只有 1 个密码框（新建账号那一个）",
          g["pwCount"] == 1 and g["pwInCreate"] == 1,
          f'全页={g["pwCount"]} 新建表单内={g["pwInCreate"]} 别处={g["pwElsewhere"]}')

    pg.locator(".tu-row .ant-btn", has_text="修改密码").first.click()
    pg.wait_for_timeout(300)
    g_open = pg.evaluate(GEO)
    check("开「修改密码」：页面上多出 1 个密码框（共 2 个）", g_open["pwCount"] == 2,
          f'全页={g_open["pwCount"]} 别处={g_open["pwElsewhere"]}')

    # antd 会给两个汉字的按钮插一个空格（渲染成「取 消」）⇒ 不能按整词匹配，按序取第一个
    pg.locator(".ant-modal-footer .ant-btn").first.click()
    pg.wait_for_timeout(400)
    g_closed = pg.evaluate(GEO)
    check("关窗后回到 1 个密码框（改密框已从 DOM 摘掉）",
          g_closed["pwCount"] == 1 and g_closed["pwElsewhere"] == 0,
          f'全页={g_closed["pwCount"]} 别处={g_closed["pwElsewhere"]}')
    check("关窗后弹窗壳仍在 DOM 里（说明摘的是框、不是整个弹窗——符合 forceRender 的形态）",
          g_closed["modalWrap"] >= 1, f'modalWrap={g_closed["modalWrap"]}')
    check("新建账号框声明为新建凭据（autocomplete=new-password）",
          pg.evaluate("""() => { const i = [...document.querySelectorAll('.tu-create input')]
                                  .find((x) => x.type === 'password'); return i ? i.autocomplete : ''; }""")
          == "new-password")
    check("第三节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 四、评论管理：同款内滚动 + 表头吸顶 + 分页条钉底 ────────────────────────
    print("\n【四】评论管理：工具栏固定、表头吸顶、分页条钉底")
    pg = mount(br, path="/dashboard/users?tab=review", wait=".BoardManage .ant-table-row")
    pg.wait_for_timeout(400)
    g = pg.evaluate("""() => {
        const R = (el) => { const b = el.getBoundingClientRect();
            return {t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), h: +b.height.toFixed(1)}; };
        const q = (s) => document.querySelector(s);
        const sc = q('.bm-scroll');
        return {
            root: R(document.getElementById('root')),
            bm: R(q('.BoardManage')), bar: R(q('.bm-toolbar')), review: R(q('.bm-review')),
            sc: R(sc), foot: R(q('.bm-foot')),
            overflow: getComputedStyle(q('.BoardManage')).overflowY,
            scroll: {sh: sc.scrollHeight, ch: sc.clientHeight},
            rows: document.querySelectorAll('.bm-scroll .ant-table-row').length,
            pagers: document.querySelectorAll('.bm-foot .ant-pagination-item').length,
            paginationInTable: document.querySelectorAll('.bm-scroll .ant-pagination').length,
            tabs: q('.bm-tabs .sel') ? q('.bm-tabs .sel').textContent : '',
        };
    }""")
    check("评论管理真的挂上了（默认落在 ?tab=review）", g["rows"] == 10, f'rows={g["rows"]}')
    check("前置：表格内容真的溢出了（否则滚动断言是空转）",
          g["scroll"]["sh"] > g["scroll"]["ch"] + 40, f'{g["scroll"]["sh"]} vs {g["scroll"]["ch"]}')
    check("整块不再自己滚（.BoardManage overflow-y: hidden）", g["overflow"] == "hidden", g["overflow"])
    check("滚动落在表格区上（.bm-scroll overflow-y: auto）",
          pg.evaluate("() => getComputedStyle(document.querySelector('.bm-scroll')).overflowY") == "auto",
          pg.evaluate("() => getComputedStyle(document.querySelector('.bm-scroll')).overflowY"))
    check("分页条移出了滚动区（表格里没有 .ant-pagination）", g["paginationInTable"] == 0,
          f'in-table={g["paginationInTable"]}')
    # 同账号那一条：`.BoardManage` 有 20px 下内边距，分页条落在那之内就算钉住了
    foot_gap = g["bm"]["b"] - g["foot"]["b"]
    check("分页条钉在卡片底部（下方只留容器那 20px 内边距）",
          0 <= foot_gap <= 24, f'分页底 {g["foot"]["b"]} / 块底 {g["bm"]["b"]}（差 {foot_gap:.1f}px）')
    # 真正的判据是"它在滚动区**之外**"（在下面、只隔一个 flex gap），不是"贴着某条线"：
    # 贴着线是巧合，而在滚动区之外是"滚多远都看得见"的全部理由
    gap_f = g["foot"]["t"] - g["sc"]["b"]
    check("分页条在滚动区之外（下方只隔一个 flex gap，滚多远都看得见）",
          0 <= gap_f <= 20, f'分页顶 {g["foot"]["t"]} / 滚动区底 {g["sc"]["b"]}（差 {gap_f:.1f}px）')
    check("4 页留言都在（共 40 条 / 每页 10）", g["pagers"] == 4, f'pagers={g["pagers"]}')

    bm_scrollers = pg.evaluate("""() => {
        const row = document.querySelector('.bm-scroll .ant-table-row');
        const out = [];
        for (let el = row.parentElement; el; el = el.parentElement) {
            const oy = getComputedStyle(el).overflowY;
            if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
                out.push(el.className || el.tagName);
            }
        }
        return out;
    }""")
    check("从留言行往上只有 .bm-scroll 一个可滚祖先（工具栏/审核开关结构上就滚不走）",
          len(bm_scrollers) == 1 and 'bm-scroll' in bm_scrollers[0], str(bm_scrollers))

    stuck = pg.evaluate("""() => {
        const sc = document.querySelector('.bm-scroll');
        const bar = document.querySelector('.bm-toolbar');
        const rev = document.querySelector('.bm-review');
        const th = document.querySelector('.bm-scroll .ant-table-thead th');
        const row0 = document.querySelector('.bm-scroll .ant-table-row');
        const before = { barTop: bar.getBoundingClientRect().top,
                         revTop: rev.getBoundingClientRect().top,
                         rowTop: row0.getBoundingClientRect().top };
        sc.scrollTop = sc.scrollHeight;
        return { before,
                 barTop: bar.getBoundingClientRect().top,
                 revTop: rev.getBoundingClientRect().top,
                 rowTop: row0.getBoundingClientRect().top,
                 thTop: th.getBoundingClientRect().top,
                 scTop: sc.getBoundingClientRect().top,
                 scrolled: sc.scrollTop };
    }""")
    check("滚到底：筛选栏一动不动", abs(stuck["barTop"] - stuck["before"]["barTop"]) < 1,
          f'{stuck["before"]["barTop"]} → {stuck["barTop"]}')
    check("滚到底：审核开关那一行也一动不动", abs(stuck["revTop"] - stuck["before"]["revTop"]) < 1,
          f'{stuck["before"]["revTop"]} → {stuck["revTop"]}')
    check("滚到底：表头吸在滚动区顶沿（sticky 生效）",
          stuck["scrolled"] > 20 and abs(stuck["thTop"] - stuck["scTop"]) < 2,
          f'th={stuck["thTop"]} 区顶={stuck["scTop"]} scrollTop={stuck["scrolled"]}')
    check("滚到底：留言行确实滚上去了",
          stuck["rowTop"] < stuck["before"]["rowTop"] - 100,
          f'{stuck["before"]["rowTop"]} → {stuck["rowTop"]}')

    # 筛选条件一变就回第一页：否则会停在"第 3 页"而结果只剩 1 页，表格空着
    p1_rows = pg.evaluate("() => [...document.querySelectorAll('.bm-scroll .bm-content')].map((e) => e.textContent)")
    pg.locator(".bm-foot .ant-pagination-item-2").first.click()
    pg.wait_for_timeout(300)
    check("翻到第 2 页", pg.evaluate(
        "() => document.querySelector('.bm-foot .ant-pagination-item-active').textContent") == "2")
    # 判"切片真的换了一批"而不是"第 11 条"：假数据是按 createTime 排的（测试里没有
    # 真实时序保证），盯死某一条等于把假数据的排序当成契约
    p2_rows = pg.evaluate("() => [...document.querySelectorAll('.bm-scroll .bm-content')].map((e) => e.textContent)")
    check("第 2 页换了一批行（与第 1 页无重叠、条数仍为 10）",
          len(p2_rows) == 10 and not (set(p2_rows) & set(p1_rows)),
          f'第1页首行={p1_rows[0]} 第2页首行={p2_rows[0]} 重叠={sorted(set(p2_rows) & set(p1_rows))}')
    pg.locator(".bm-tabs button", has_text="愿").first.click()
    pg.wait_for_timeout(300)
    check("换筛选条件后回到第 1 页（不停在结果之外的空页）",
          pg.evaluate("() => document.querySelector('.bm-foot .ant-pagination-item-active').textContent") == "1",
          pg.evaluate("() => document.querySelector('.bm-foot').textContent"))
    check("换筛选后计数与行数一致（只有「愿」这一档 = 10 条）",
          "共 10 条留言" in pg.evaluate("() => document.querySelector('.bm-count').textContent")
          and pg.evaluate("() => document.querySelectorAll('.bm-scroll .ant-table-row').length") == 10,
          pg.evaluate("() => document.querySelector('.bm-count').textContent"))
    check("第四节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 五、冻结账号（20260926）────────────────────────────────────────────────
    # 这一节要证明的是一条**端到端**的事：点「冻结」真的会让那一行从"正常"变成
    # "冻结"，而这件事在页面上看得见、在库里（这里是桩）也真的改了。
    # 只断言"按钮文案变成解冻"是不够的——文案可以由本地 state 翻转出来，
    # 而后端一个字节都没收到。
    print("\n【五】账号管理的冻结账号筛选与冻结/解冻")
    pg = mount(br)

    # ① 冻结筛选只按状态（不看角色）
    pg.locator(".tu-tabs button", has_text="冻结账号").first.click()
    pg.wait_for_timeout(250)
    g = pg.evaluate(GEO)
    frozen_names = sorted(r["u"] for r in g["freezeBtns"])
    check("筛「冻结账号」：恰好是预置冻结的那两行（guest27/guest28）",
          frozen_names == ["guest27", "guest28"], str(frozen_names))
    check("冻结行上都带「已冻结」标签", all(r["tag"] for r in g["freezeBtns"]), str(g["freezeBtns"]))
    check("冻结行上的按钮是「解冻」且不套 danger 色",
          all(r["label"] == "解冻" and not r["danger"] for r in g["freezeBtns"]), str(g["freezeBtns"]))
    check("计数跟着筛（共 2 个账号）", "共 2 个账号" in g["count"], g["count"])

    # ② 角色筛选**不**排除冻结账号（"他是普通用户"与"他现在不能用"同时为真）
    pg.locator(".tu-tabs button", has_text="普通用户账号").first.click()
    pg.wait_for_timeout(250)
    g = pg.evaluate(GEO)
    names = [r["u"] for r in g["delBtns"]]
    check("筛「普通用户账号」时冻结行**仍在**（角色筛选不吞掉状态信息）",
          "guest27" in names and "guest28" in names and len(names) == 29, f'{len(names)} 行')

    # ③ 未冻结行上是「冻结」、套 danger
    normal = [r for r in g["freezeBtns"] if r["u"] == "guest1"][0]
    check("未冻结行上的按钮是「冻结」且套 danger 色",
          normal["label"] == "冻结" and normal["danger"], str(normal))

    # ④ 点一下 ⇒ **先弹确认框**；取消不许下手，确认之后请求体是 {frozen:false}
    pg.locator(".tu-tabs button", has_text="冻结账号").first.click()
    pg.wait_for_timeout(250)
    before = pg.evaluate("() => window.__calls.length")
    pg.locator(".tu-row", has_text="guest27").locator(".tu-freeze-btn").click()
    pg.wait_for_timeout(300)
    dlg = pg.evaluate(STATUS_DIALOG)
    check("点「解冻」是先弹确认框，不是直接下手", dlg is not None, str(dlg))
    check("确认框标题是「解冻账号」（按这一下的方向取，不是一句笼统标题）",
          dlg and dlg["title"] == "解冻账号", str(dlg and dlg["title"]))
    check("确认按钮上的字是动作词「解冻」，不是「确定/OK」",
          dlg and dlg["ok"] == "解冻", str(dlg and dlg["ok"]))
    check("确认框里点了名（写清是哪个账号）", dlg and "guest27" in dlg["body"],
          str(dlg and dlg["body"]))
    check("解冻那一侧的确认按钮不套 danger（与行上按钮同一套极性）",
          dlg and not dlg["okDanger"], str(dlg and dlg["okDanger"]))
    check("**弹窗开着的时候一个状态请求都没发**（动作必须等那一下确认）",
          status_posts(pg) == [], str(status_posts(pg)))

    # ④b 取消 ⇒ 什么都不该发生（"取消也要真的取消"是最容易写成样子货的一条）
    # 按类名取取消按钮，不按 `.ant-btn-default` 取：改密码那个弹窗是 forceRender 的，
    # 它的取消按钮此刻也在 DOM 里（display:none），按类名取会命中两个。
    pg.locator(".tu-status-cancel").click()
    pg.wait_for_timeout(300)
    check("点取消：弹窗关掉且**零请求**（没有偷偷把动作做掉）",
          pg.evaluate(STATUS_DIALOG) is None and status_posts(pg) == [],
          f'dlg={pg.evaluate(STATUS_DIALOG)} posts={status_posts(pg)}')

    # ④c 再来一次并确认 ⇒ 这才是唯一会发请求的路径
    pg.locator(".tu-row", has_text="guest27").locator(".tu-freeze-btn").click()
    pg.wait_for_timeout(300)
    pg.locator(".ant-modal-wrap .tu-status-ok").click()
    pg.wait_for_timeout(600)
    posts = status_posts(pg)
    check("点「解冻」发出 POST /api/temp-users/126/status", len(posts) == 1
          and posts[0]["url"] == "/api/temp-users/126/status", str(posts))
    check("请求体是 {frozen:false}（传目标状态，不是让后端自己取反）",
          posts and posts[0]["body"] == {"frozen": False}, str(posts[0]["body"] if posts else None))
    check("改完重新拉了一次列表（不是只在本地翻转 state）",
          pg.evaluate("() => window.__calls.length") > before + 1,
          f'before={before} after={pg.evaluate("() => window.__calls.length")}')
    check("解冻后它离开「冻结账号」这一档（桩真按请求体改了那一行）",
          [r["u"] for r in pg.evaluate(GEO)["freezeBtns"]] == ["guest28"],
          str([r["u"] for r in pg.evaluate(GEO)["freezeBtns"]]))

    # ⑤ 反向再来一次：冻结一个正常账号 ⇒ 它进冻结档。
    # 行定位用 `:text-is("guest1")` 精确匹配——`has_text` 是包含匹配，
    # 会同时命中 guest1/guest10../guest19（本文件第二节也踩过同一个坑）。
    pg.locator(".tu-tabs button", has_text="全部").first.click()
    pg.wait_for_timeout(250)
    pg.locator('.tu-row:has(strong:text-is("guest1")) .tu-freeze-btn').click()
    pg.wait_for_timeout(300)
    dlg2 = pg.evaluate(STATUS_DIALOG)
    check("冻结这一侧：标题「冻结账号」、按钮上是「冻结」",
          dlg2 and dlg2["title"] == "冻结账号" and dlg2["ok"] == "冻结", str(dlg2))
    check("冻结那一侧的确认按钮套 danger（红按钮 = 会让对方下线的那一下）",
          dlg2 and dlg2["okDanger"], str(dlg2 and dlg2["okDanger"]))
    check("冻结的后果写在弹窗里（含「登录状态立即失效」这层意思）",
          dlg2 and "立即失效" in dlg2["body"], str(dlg2 and dlg2["body"]))
    pg.locator(".ant-modal-wrap .tu-status-ok").click()
    pg.wait_for_timeout(600)
    last = status_posts(pg)[-1] if status_posts(pg) else None
    check("点「冻结」发出 {frozen:true}（与解冻走同一个接口、只换请求体）",
          last and last["body"] == {"frozen": True}, str(last))
    # ④d 成功提示弹的必须是**后端那句中文**，不是字面量 "ok"（20260926 用户报的现场）。
    # 后端 `ApiResponse::success(data)` 的 `message` 恒为 "ok"、人类可读的那句在 `data`
    # —— 读错字段的写法（`message.success(res.data.message)`）弹出来就是一个只有
    # 「ok」的条，而且它**不会报错、不会红**，只有真看 DOM 才发现。
    _n = notices(pg)
    check("成功提示是后端那句中文（账号已冻结…）",
          any("账号已冻结" in x for x in _n), str(_n))
    check("提示里**没有**那个只有「ok」的条（读错字段的写法）",
          not any(x.strip().lower() == "ok" for x in _n), str(_n))
    pg.locator(".tu-tabs button", has_text="冻结账号").first.click()
    pg.wait_for_timeout(250)
    check("冻结后 guest1 出现在冻结档（预置只剩 guest28，加它就是两行）",
          sorted(r["u"] for r in pg.evaluate(GEO)["freezeBtns"]) == ["guest1", "guest28"],
          str(sorted(r["u"] for r in pg.evaluate(GEO)["freezeBtns"])))

    # ⑥ 未登记的状态值也按冻结处理 —— 前端那句"与后端 is_frozen 同口径"是要**验**的。
    # 后端判的是 `status != 0`（不是 `== 1`），库里出现第三种值时两边必须一起往
    # "不能用"倒。判据差一个字符（`!== 0` 写成 `=== 1`）时，这条正好变红。
    pg.evaluate("() => { window.__users.find((u) => u.id === 101).status = 2 }")
    # 顺手点一下解冻（会把 guest1 解掉）：这一下必然重新拉列表，正好把上面改的值带进来
    pg.locator('.tu-row:has(strong:text-is("guest1")) .tu-freeze-btn').click()
    pg.wait_for_timeout(300)
    pg.locator(".ant-modal-wrap .tu-status-ok").click()
    pg.wait_for_timeout(600)
    pg.locator(".tu-tabs button", has_text="冻结账号").first.click()
    pg.wait_for_timeout(250)
    names = [r["u"] for r in pg.evaluate(GEO)["freezeBtns"]]
    check("未登记的状态值（2）也按冻结处理（与后端 is_frozen 同口径）",
          "guest2" in names and "guest1" not in names, str(names))
    check("第五节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 六、超级管理员视角（20260926）──────────────────────────────────────────
    # 这一节验的是**按钮亮不亮**这条界面分流，而它有**三个**分支、三条判据各不相同：
    #   ① 我是管理员、这一行是我自己        → 挡（后端 `check_freeze` 的 SelfTarget）
    #   ② 我是管理员、这一行是另一个管理员  → 挡（PeerAdmin）
    #   ③ 我是超管、这一行是管理员          → **放行**（超管冻管理员是允许的）
    # 三条混成一条实现（例如"对方是管理员就挡"）会在①③上同时出错：①的说明会说成
    # "管理员之间"（答非所问），③会把超管的能力一起挡掉。所以三条各验一次。
    #
    # ⚠️ 夹具里**没有超管那一行**，而且这不是漏了：超管不进后台列表是**后端**的过滤
    # （`authz::is_listable_role`，见 src/routes/temp_user.rs），接口根本不返回它。
    # 在这里塞一行再断言"它没显示"，测的是前端有没有自己再滤一遍——前端**不该**有
    # 那一层：真漏出来时，看得见比悄悄吞掉好得多（那正是后端那道闸坏了的证据）。
    print("\n【六】超级管理员视角：谁该挡、谁该放行、变更身份")
    # ① 管理员看自己那一行（夹具里的 root_admin 就是 uid 1 = 默认令牌的 sub）
    pg = mount(br)
    g = pg.evaluate(GEO)
    me = [r for r in g["freezeBtns"] if r["u"] == "root_admin"][0]
    check("管理员看**自己**那一行：冻结按钮禁用（后端也拒：冻了自己就再也解不开）",
          me["disabled"] is True, str(me))
    tips = tooltips(pg, '.tu-row:has(strong:text-is("root_admin")) .tu-freeze-btn')
    check("自己那一行的说明是「不能冻结自己的账号」（与后端同一句话，不是「管理员之间」）",
          any("不能冻结自己的账号" in t for t in tips), str(tips))
    # 变更身份（20261002 下放）：管理员**能改的只有低两档**——
    # 够得着的行有入口、够不着的行连按钮都不渲染（不是禁用：禁用会让人以为"本可以有"）。
    # 两半一起断言，只看一半都测不出判据写反（"全都有"或"全都没有"都能单过一半）。
    _low = [r for r in g["roleBtns"] if r["role"] in ("user", "zako")]
    _high = [r for r in g["roleBtns"] if r["role"] not in ("user", "zako")]
    check("管理员视角：普通用户/杂鱼那些行**有**「变更身份」入口",
          _low and all(r["has"] for r in _low),
          str([r["u"] for r in _low if not r["has"]]))
    check("管理员视角：管理员/秘书那些行**一个入口都没有**（够不着，不是禁用）",
          _high and not any(r["has"] for r in _high),
          str([r["u"] for r in _high if r["has"]]))
    check("合起来 = 恰好 28 行有入口（30 行里排除管理员与秘书那两行）",
          sum(1 for r in g["roleBtns"] if r["has"]) == 28,
          str(sum(1 for r in g["roleBtns"] if r["has"])))
    # 徽章（20261002 B 件）在后台行上也要认得出身份——杂鱼行是唯一一枚非「已冻结」标签
    check("杂鱼那一行挂着「杂鱼」徽章（data-role=zako，文案走 aria-label）",
          pg.get_attribute('.tu-row:has(strong:text-is("guest20")) [data-role]', 'aria-label') == "杂鱼"
          and pg.get_attribute('.tu-row:has(strong:text-is("guest20")) [data-role]', 'data-role') == "zako",
          str(pg.get_attribute('.tu-row:has(strong:text-is("guest20")) [data-role]', 'aria-label')))
    check("普通用户那行**不挂**徽章（既有规则：后台行上只标出例外）",
          pg.locator('.tu-row:has(strong:text-is("guest1")) [data-role]').count() == 0,
          str(pg.locator('.tu-row:has(strong:text-is("guest1")) [data-role]').count()))
    check("第六节①无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ①b 管理员打开菜单：**恰好只剩另一档**（当前身份不列，够不着的档也不列）
    # 这一条锁的是"两档之间搬"在界面上的形状：普通用户那行只剩「杂鱼」、
    # 杂鱼那行只剩「普通用户」——菜单里出现第三项就说明档位收窄没生效。
    pg = mount(br)
    pg.locator('.tu-row:has(strong:text-is("guest1")) .tu-role-btn').click()
    pg.wait_for_timeout(300)
    check("管理员点普通用户那行：菜单只剩「杂鱼」一项",
          menu_items(pg) == ["杂鱼"], str(menu_items(pg)))
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(200)
    pg.locator('.tu-row:has(strong:text-is("guest20")) .tu-role-btn').click()
    pg.wait_for_timeout(300)
    check("管理员点杂鱼那行：菜单只剩「普通用户」一项（两个方向都通）",
          menu_items(pg) == ["普通用户"], str(menu_items(pg)))
    check("第六节①b无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ② 管理员看**另一个**管理员那一行（uid 换成不在名单里的 721）
    pg = mount(br, uid=721)
    g = pg.evaluate(GEO)
    peer = [r for r in g["freezeBtns"] if r["u"] == "root_admin"][0]
    check("管理员看**同级**那一行：冻结按钮禁用", peer["disabled"] is True, str(peer))
    tips = tooltips(pg, '.tu-row:has(strong:text-is("root_admin")) .tu-freeze-btn')
    check("说明是「管理员之间不可互相冻结」",
          any("管理员之间不可互相冻结" in t for t in tips), str(tips))
    guest = [r for r in g["freezeBtns"] if r["u"] == "guest1"][0]
    check("同一页上普通账号那一行照常可用（禁的是那一行，不是整列）",
          guest["disabled"] is False, str(guest))
    check("第六节②无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ③ 超管视角：管理员那一行**可用**，且每行都有变更身份
    # uid 用 721 而不是默认的 1：夹具里 id 1 恰好是 root_admin 那一行（①验的就是"自己
    # 那一行"，判据读的是令牌 sub）——不换 uid 的话，这一行会被"不能冻自己"先挡上，
    # 于是这条断言测的是另一件事。生产里超管账号根本不在列表里，不存在这个碰撞。
    pg = mount(br, role="superadmin", uid=721)
    g = pg.evaluate(GEO)
    adm = [r for r in g["freezeBtns"] if r["u"] == "root_admin"][0]
    check("超管看管理员那一行：冻结按钮**可用**（超管不受「管理员之间」那条限制）",
          adm["disabled"] is False, str(adm))
    check("超管视角下每一行都有「变更身份」", all(r["has"] for r in g["roleBtns"]),
          str([r for r in g["roleBtns"] if not r["has"]]))

    # ③b 走一遍变更身份：秘书 → 普通用户（降级）看弹窗，再改成管理员（升级）看真的发出去
    pg.locator('.tu-row:has(strong:text-is("sec_zhang")) .tu-role-btn').click()
    pg.wait_for_timeout(300)
    menu = menu_items(pg)
    # 20261002 加了杂鱼：可指派范围变成四档，菜单按 `ASSIGNABLE_ROLES` 的顺序排。
    check("点「变更身份」：菜单是**另三档**（不列当前身份，也没有超级管理员这一档）",
          menu == ["杂鱼", "普通用户", "管理员"], str(menu))
    click_menu_item(pg, "普通用户")
    pg.wait_for_timeout(300)
    d = pg.evaluate(ROLE_DIALOG)
    check("选一档之后是**先弹确认框**，不是直接下手", d is not None, str(d))
    check("确认框标题带目标账号名", d and "sec_zhang" in d["title"], str(d and d["title"]))
    check("确认按钮上是这一下的动作词「改成普通用户」，不是「确定/OK」",
          d and d["ok"] == "改成普通用户", str(d and d["ok"]))
    check("正文写清改前改后两个身份", d and "秘书" in d["body"] and "普通用户" in d["body"],
          str(d and d["body"]))
    check("正文写清该账号会被踢下线（这是这次变更唯一不可逆的那半边）",
          d and "立即失效" in d["body"], str(d and d["body"]))
    check("降级那一侧套 danger（与「冻结」同一套极性：收窄权限 = 红）",
          d and d["okDanger"], str(d and d["okDanger"]))
    check("**弹窗开着时一个改身份请求都没发**", role_posts(pg) == [], str(role_posts(pg)))
    pg.locator(".tu-role-cancel").click()
    pg.wait_for_timeout(300)
    check("点取消：关窗且零请求",
          pg.evaluate(ROLE_DIALOG) is None and role_posts(pg) == [],
          f'dlg={pg.evaluate(ROLE_DIALOG)} posts={role_posts(pg)}')

    before = pg.evaluate("() => window.__calls.length")
    pg.locator('.tu-row:has(strong:text-is("sec_zhang")) .tu-role-btn').click()
    pg.wait_for_timeout(300)
    click_menu_item(pg, "管理员")
    pg.wait_for_timeout(300)
    d2 = pg.evaluate(ROLE_DIALOG)
    check("升级那一侧**不**套 danger（给权限不是「危险动作」，与「解冻」同一套极性）",
          d2 and not d2["okDanger"] and d2["ok"] == "改成管理员", str(d2))
    pg.locator(".ant-modal-wrap .tu-role-ok").click()
    pg.wait_for_timeout(700)
    posts = role_posts(pg)
    check("确认后发出 POST /api/temp-users/200/role",
          len(posts) == 1 and posts[0]["url"] == "/api/temp-users/200/role", str(posts))
    check("请求体是 {role:'admin'}（传目标身份，不让后端猜方向）",
          posts and posts[0]["body"] == {"role": "admin"},
          str(posts[0]["body"] if posts else None))
    check("改完重新拉了一次列表（不是只在本地翻转 state）",
          pg.evaluate("() => window.__calls.length") > before + 1,
          f'before={before} after={pg.evaluate("() => window.__calls.length")}')
    tags = {r["u"]: r["tag"] for r in pg.evaluate(GEO)["roleTags"]}
    check("行上的角色标签跟着变了（秘书 → 管理员；桩真按请求体改了那一行）",
          tags.get("sec_zhang") == "管理员", str(tags.get("sec_zhang")))
    _n = notices(pg)
    check("成功提示是后端那句中文（身份已改为管理员…）",
          any("身份已改为管理员" in x for x in _n), str(_n))
    check("提示里**没有**只有「ok」的条（读错字段的写法）",
          not any(x.strip().lower() == "ok" for x in _n), str(_n))

    # ③c 被拒那一侧：原因在 **message** 里（`ApiResponse::error` 没有 data），
    # 与成功那两个字段的方位**正好相反** —— 读错任一侧都会弹一个空条。
    pg.evaluate("() => { window.__roleDeny = '只有超级管理员可以变更账号身份' }")
    pg.locator('.tu-row:has(strong:text-is("root_admin")) .tu-role-btn').click()
    pg.wait_for_timeout(300)
    click_menu_item(pg, "普通用户")
    pg.wait_for_timeout(300)
    pg.locator(".ant-modal-wrap .tu-role-ok").click()
    pg.wait_for_timeout(700)
    _n = notices(pg)
    check("被拒时弹的是后端那句原因（它在 message 里，读 data 会弹个空条）",
          any("只有超级管理员可以变更账号身份" in x for x in _n), str(_n))
    tags = {r["u"]: r["tag"] for r in pg.evaluate(GEO)["roleTags"]}
    check("被拒那一行的身份没变（桩没改，页面也不许假装改过）",
          tags.get("root_admin") == "管理员", str(tags.get("root_admin")))
    check("第六节③无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ④ 令牌解析不出来时页面照常（`getRoleFromToken` 的契约是"返回 null，不抛"）：
    # 老令牌/被改坏的令牌不该让整个后台账号页白屏——那时连"哪个按钮亮着"都无从谈起。
    pg = mount(br, role=None)
    g = pg.evaluate(GEO)
    check("令牌解析不出时页面仍然渲染（30 行都在）", g["rows"] == 30, f'rows={g["rows"]}')
    check("解析不出 ⇒ 冻结按钮全部可用、没有任何改身份入口（按最保守的界面给）",
          all(r["disabled"] is False for r in g["freezeBtns"])
          and not any(r["has"] for r in g["roleBtns"]),
          str([r for r in g["freezeBtns"] if r["disabled"]]))
    check("第六节④无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 七、发通知（20260926）──────────────────────────────────────────────────
    # 这一节锁的是"给单个账号发一条站内通知"这条新通道在界面上的形状。判据分四层：
    #   ① **每一行都有入口**（收件人合不合法由后端判，这一页不按角色分流）；
    #   ② **先弹窗、弹窗开着时零请求**（与冻结/改身份同一个"点下去才发"的纪律）；
    #   ③ **正文为空时主按钮禁用**——这是"必填"在界面上的形态。后端也会拒，但那要
    #      往返一趟；前端这道只是"别让人白填一次"；
    #   ④ 请求体是 `{title, content}` 的**真填值**（标题留空就原样传空串，默认标题
    #      由后端给——"系统自己写的字"只有那一处来源）。
    # 另锁两条本页已经踩过的坑：成功那句中文在 `data` 里（弹的不能是一个只有「ok」
    # 的条）、被拒那句在 `message` 里（方位正好相反）。
    print("\n【七】发通知：每行一个入口 + 先弹窗 + 正文必填 + 请求体形状")
    pg = mount(br)
    g = pg.evaluate(GEO)
    check("每一行都有「发通知」按钮（收件人合不合法由后端判，前端不分流）",
          all(r["has"] for r in g["notifyBtns"]) and len(g["notifyBtns"]) == 30,
          str([r for r in g["notifyBtns"] if not r["has"]]))
    check("关着的发通知弹窗**不在 DOM 里**（`forceRender` + 条件渲染：输入框不常驻，"
          "否则又会喂给 Chrome 那个「整页是一个合成表单」的判定）",
          pg.evaluate("() => document.querySelector('.tu-notify-title')") is None
          and pg.evaluate("() => document.querySelector('.tu-notify-body textarea')") is None)

    pg.locator('.tu-row:has(strong:text-is("guest1")) .tu-notify-btn').click()
    pg.wait_for_timeout(300)
    d = pg.evaluate(NOTIFY_DIALOG)
    check("点「发通知」先弹窗（不是直接下手）", d is not None, str(d))
    check("弹窗标题带目标账号名", d and "guest1" in d["title"], str(d and d["title"]))
    check("两个输入框都挂出来了（标题 input + 正文 textarea）",
          d and d["fieldsPresent"], str(d))
    check("正文为空 ⇒ 主按钮**禁用**（界面上的「必填」）",
          d and d["okDisabled"] is True, str(d))
    check("主按钮上写的是这一下的动作词「发送」，不是「确定/OK」",
          d and d["ok"] == "发送", str(d and d["ok"]))
    check("弹窗正文写明这条通知会进对方个人中心且发出去收不回",
          d and "个人中心" in d["body"] and "无法撤回" in d["body"], str(d and d["body"]))
    # 禁用按钮点不动（playwright 的可操作性检查会拦，用 force）——重点是**零请求**
    pg.locator(".ant-modal-wrap .tu-notify-ok").click(force=True)
    pg.wait_for_timeout(400)
    check("正文为空时点主按钮：**一个请求都没发**（禁用不只是个样式）",
          notice_posts(pg) == [], str(notice_posts(pg)))

    pg.locator(".tu-notify-body textarea").fill("请在下周三之前把资料补齐")
    pg.wait_for_timeout(200)
    d = pg.evaluate(NOTIFY_DIALOG)
    check("填了正文 ⇒ 主按钮可用", d and d["okDisabled"] is False, str(d))

    # ★「字数计数遮挡发送按钮」（20260929 用户反馈）：antd 的 showCount 把计数
    #   **绝对定位**在输入框下方约 22px 处（不占布局空间），而 Modal footer 的
    #   `margin-top` 只有 12px ⇒ 计数整条压在下面那颗按钮上。修法是给 TextArea 挂
    #   `.counter-room`（值在 src/index.css 一处）。这里量**几何重叠**——
    #   "CSS 写对了"和"真的没被压住"是两件事（同个人中心那条断言的理由）。
    cnt = pg.evaluate("""() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find(
            (w) => getComputedStyle(w).display !== 'none' && w.querySelector('.tu-notify-ok'));
        if (!m) return null;
        const c = m.querySelector('.ant-input-data-count');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        const ta = m.querySelector('.tu-notify-body textarea').getBoundingClientRect();
        const btn = m.querySelector('.tu-notify-ok').getBoundingClientRect();
        const cs = getComputedStyle(c);
        return {text: c.textContent, countTop: Math.round(r.top),
                countBottom: Math.round(r.bottom), taBottom: Math.round(ta.bottom),
                btnTop: Math.round(btn.top),
                visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'};
    }""")
    check("字数计数（N / 1000）真的渲染出来了", bool(cnt) and cnt["visible"], str(cnt))
    check("计数在正文输入框下方", bool(cnt) and cnt["countTop"] >= cnt["taBottom"] - 1, str(cnt))
    check("计数**不再压在「发送」按钮上**（计数底 ≤ 按钮顶）",
          bool(cnt) and cnt["countBottom"] <= cnt["btnTop"], str(cnt))
    check("计数内容如实反映输入长度", bool(cnt) and cnt["text"].startswith("12 / 1000"),
          str(cnt and cnt["text"]))
    check("**弹窗开着、正文也填好了，仍是一个请求都没发**（点下去才发）",
          notice_posts(pg) == [], str(notice_posts(pg)))
    pg.locator(".tu-notify-cancel").click()
    pg.wait_for_timeout(300)
    check("点取消：关窗、零请求、两个输入框从 DOM 里摘掉",
          pg.evaluate(NOTIFY_DIALOG) is None and notice_posts(pg) == []
          and pg.evaluate("() => document.querySelector('.tu-notify-body textarea')") is None,
          f'dlg={pg.evaluate(NOTIFY_DIALOG)} posts={notice_posts(pg)}')

    # 标题留空走一遍：请求体里 title 是**空串**（默认标题由后端取，前端不另写一份）
    pg.locator('.tu-row:has(strong:text-is("guest1")) .tu-notify-btn').click()
    pg.wait_for_timeout(300)
    pg.locator(".tu-notify-body textarea").fill("  请在下周三之前把资料补齐  ")
    pg.wait_for_timeout(200)
    pg.locator(".ant-modal-wrap .tu-notify-ok").click()
    pg.wait_for_timeout(700)
    posts = notice_posts(pg)
    check("确认后发出 POST /api/temp-users/100/notice",
          len(posts) == 1 and posts[0]["url"] == "/api/temp-users/100/notice", str(posts))
    check("请求体是 {title:'', content:去空白的正文}",
          posts and posts[0]["body"] == {"title": "", "content": "请在下周三之前把资料补齐"},
          str(posts[0]["body"] if posts else None))
    _n = notices(pg)
    check("成功提示是后端那句中文（已把通知发给「guest1」）",
          any("已把通知发给" in x and "guest1" in x for x in _n), str(_n))
    check("提示里**没有**只有「ok」的条（读错字段的写法）",
          not any(x.strip().lower() == "ok" for x in _n), str(_n))
    check("发通知**不重拉账号列表**（通知不改这一页的任何一行）",
          pg.evaluate("() => window.__calls.filter((c) => c.method === 'GET').length") == 1,
          str(pg.evaluate("() => window.__calls.filter((c) => c.method==='GET').map((c)=>c.url)")))

    # 填全两项走一遍：标题也要真的进请求体
    pg.locator('.tu-row:has(strong:text-is("sec_zhang")) .tu-notify-btn').click()
    pg.wait_for_timeout(300)
    pg.locator(".tu-notify-title").fill("资料补齐提醒")
    pg.locator(".tu-notify-body textarea").fill("请补齐资料")
    pg.wait_for_timeout(200)
    pg.locator(".ant-modal-wrap .tu-notify-ok").click()
    pg.wait_for_timeout(700)
    posts = notice_posts(pg)
    check("填了标题 ⇒ 请求体里带上它（收件人是另一行：sec_zhang = id 200）",
          len(posts) == 2 and posts[-1]["url"] == "/api/temp-users/200/notice"
          and posts[-1]["body"] == {"title": "资料补齐提醒", "content": "请补齐资料"},
          str(posts[-1] if posts else None))

    # 被拒那一侧：原因在 **message** 里（`ApiResponse::error` 没有 data）
    pg.evaluate("() => { window.__noticeDeny = '该账号不能接收通知' }")
    pg.locator('.tu-row:has(strong:text-is("guest1")) .tu-notify-btn').click()
    pg.wait_for_timeout(300)
    pg.locator(".tu-notify-body textarea").fill("再试一次")
    pg.wait_for_timeout(200)
    pg.locator(".ant-modal-wrap .tu-notify-ok").click()
    pg.wait_for_timeout(700)
    _n = notices(pg)
    check("被拒时弹的是后端那句原因（它在 message 里，读 data 会弹个空条）",
          any("该账号不能接收通知" in x for x in _n), str(_n))
    check("第七节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 八、账号行上的额度 + 主动重置（20260929）───────────────────────────────
    # 「重置额度」是账号族第四个动作（前三个：修改密码 / 生成恢复码 / 发通知），同一条
    # 纪律：**不需要对方申请过**——按申请的裁决住在额度管理页签里（第九节）。这一节验
    # 三件事：行上那枚 chip 的**三种形态**（普通 / 不限额 / 字段缺席）、按钮的亮灭、
    # 以及受控弹窗那三条（先弹窗、确认前零请求、请求没有 body）。
    print("\n【八】账号行上的额度 chip 与「重置额度」")
    pg = mount(br)
    pg.wait_for_timeout(800)   # 账号列表是挂载后 500ms 拉的，chip 跟着那一份数据出来
    chips = quota_chips(pg)
    # 口径是**余额**（20260929b 用户拍板：从 500 往下减才符合直觉）。数字从行上读，
    # 前端不写死 500——137 用掉 ⇒ 印「剩 363」，减法只做一次（`utils/quota.ts`）。
    check("普通账号行上是「额度：剩 N / 上限」（是余额不是已用；数字从行上读，前端不写死 500）",
          chips.get("guest1") == "额度：剩363/500", str(chips.get("guest1")))
    check("不限额的账号显示「不限额」而不是 0/0（0 是「不限」，不是「上限为零」）",
          chips.get("root_admin") == "额度：不限额", str(chips.get("root_admin")))
    check("秘书照 500 算（免额角色只有 can_access_console，不按「非普通用户」一刀切）",
          chips.get("sec_zhang") == "额度：剩488/500", str(chips.get("sec_zhang")))
    check("两个字段缺席（前端已上线、后端还没到）显示「额度 —」，不是会被读成「用完了」的 0/0",
          chips.get("guest27") == "额度—", str(chips.get("guest27")))
    btns = quota_btns(pg)
    check("不限额那一行的「重置额度」是禁用的（后端也拒；让按钮不亮比点了才被告知更清楚）",
          btns.get("root_admin") is True, str(btns.get("root_admin")))
    check("普通账号那一行可点", btns.get("guest1") is False, str(btns.get("guest1")))

    pg.locator('.tu-row:has(strong:text-is("guest1")) .tu-quota-btn').click()
    pg.wait_for_timeout(300)
    d = pg.evaluate(QUOTA_RESET_DIALOG)
    check("点「重置额度」先弹窗（不是直接下手）", d is not None, str(d))
    check("弹窗标题带目标账号名", d and "guest1" in d["title"], str(d and d["title"]))
    check("主按钮上写的是这一下的动作词「重置额度」，不是「确定/OK」",
          d and d["ok"] == "重置额度", str(d and d["ok"]))
    check("**不给 danger**：清零是把额度还给对方（恢复性动作，与「解冻」同一侧）",
          d and d["okDanger"] is False, str(d and d["okDanger"]))
    check("正文写明额度回到满额、他立刻能继续对话、且界面上撤不回来",
          d and "回到满额" in d["body"] and "可以继续对话" in d["body"]
          and "撤不回来" in d["body"], str(d and d["body"]))
    # 措辞是「恢复到上限」不是「清零」（20260929 用户指出）：主人看到的是递减的余额。
    check("正文与标题里**不出现**「清零」（那是库里的实现，不是他看到的那个数）",
          d and "清零" not in d["body"] and "清零" not in d["title"],
          str(d and (d["title"], d["body"])))
    check("弹窗开着时**一个重置请求都没发**", quota_posts(pg) == [], str(quota_posts(pg)))
    before = pg.evaluate("() => window.__calls.length")
    pg.locator(".ant-modal-wrap .tu-quota-ok").click()
    pg.wait_for_timeout(900)
    posts = quota_posts(pg)
    check("确认后发出 POST /api/temp-users/100/quota-reset",
          len(posts) == 1 and posts[0]["url"] == "/api/temp-users/100/quota-reset", str(posts))
    check("请求**没有 body**（后端 handler 只有 State + Path；顺手补个 {} 会 422）",
          posts and posts[0]["body"] is None, str(posts[0]["body"] if posts else None))
    _n = notices(pg)
    check("成功提示是后端那句中文（在 data 里，读 message 只会弹一个「ok」）",
          any("对话额度恢复到" in x and "guest1" in x for x in _n), str(_n))
    check("提示里没有只有「ok」的条",
          not any(x.strip().lower() == "ok" for x in _n), str(_n))
    check("重置之后重拉账号列表（那一行的 chip 得跟着变）",
          pg.evaluate("() => window.__calls.length") > before + 1,
          f'before={before} after={pg.evaluate("() => window.__calls.length")}')
    check("重拉回来那一行真的变成满额（桩按真后端把计数器清零了）——余额口径下是「剩 500」",
          quota_chips(pg).get("guest1") == "额度：剩500/500", str(quota_chips(pg).get("guest1")))
    check("第八节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 九、额度管理页签：申请队列 + 驳回理由必填（20260929）────────────────────
    # 这一页只管**裁决队列**（与评论管理只管审核队列同构）；按账号的动作住在账号行上
    # （第八节）。两条最要紧的判据：① 筛选是**服务端**的事（桩按 status 过滤，所以
    # "切到待处理真的少一行"是端到端成立的）；② 驳回**理由必填**是这一层保证的
    # （后端只做回落，不做硬闸）。
    print("\n【九】额度管理：申请队列、三种状态、驳回理由必填")
    pg = mount(br, path="/dashboard/users?tab=quota", wait=".QuotaManage .ant-table-row")
    pg.wait_for_timeout(400)
    tabs = pg.evaluate("""() => [...document.querySelectorAll('.ant-tabs-tab')]
        .map((t) => t.textContent.replace(/\\s+/g, ''))""")
    check("三个页签都在（账号管理 / 评论管理 / 额度管理）",
          tabs == ["账号管理", "评论管理", "额度管理"], str(tabs))
    check("`?tab=quota` 深链落在额度管理上",
          pg.evaluate("() => !!document.querySelector('.QuotaManage')"), str(tabs))
    _sel = pg.evaluate("() => document.querySelector('.qm-tabs .sel').textContent")
    check("默认筛选是「待处理」（不是本地过滤——`status` 交给服务端）",
          _sel == "待处理"
          and (quota_requests(pg) and quota_requests(pg)[-1].get("status") == "pending"),
          f'sel={_sel} params={quota_requests(pg)}')
    rows = quota_rows(pg)
    check("待处理两条（已驳回那条不在这一档）", len(rows) == 2, str(rows))
    check("行上写的是申请人的**余额**（137 用掉 ⇒ 剩 363）与「待处理」——列名也叫「剩余 / 上限」",
          "剩363/500" in rows[0] and "待处理" in rows[0], rows[0])
    check("计数跟着筛选走（共 2 条申请）",
          "共2条申请" in pg.evaluate(
              "() => document.querySelector('.qm-count').textContent.replace(/\\s+/g, '')"),
          pg.evaluate("() => document.querySelector('.qm-count').textContent"))

    # 驳回：先弹窗 → 空理由禁用 → 点预设 → 确认后发请求
    pg.locator(".qm-scroll .ant-table-row").first.locator(".ant-btn-dangerous").click()
    pg.wait_for_timeout(300)
    d = pg.evaluate(QUOTA_REJECT_DIALOG)
    check("点「驳回」先弹窗", d is not None, str(d))
    check("弹窗标题带**账号名**（唯一键；昵称可空可重名，而这一下不可逆）",
          d and "guest1" in d["title"], str(d and d["title"]))
    check("正文写明驳回后额度一个字节都不动、且理由必填",
          d and "额度一个字节都不动" in d["tip"] and "理由必填" in d["tip"],
          str(d and d["tip"]))
    check("主按钮写动作词「确认驳回」并染红（驳回是收紧侧）",
          d and d["ok"] == "确认驳回" and d["okDanger"] is True, str(d))
    check("理由为空 ⇒ 主按钮**禁用**（「必填」落在界面上，不只是后端回落）",
          d and d["okDisabled"] is True, str(d))
    check("四个常见类型预设都在（点一下填进**可编辑**的文本框）",
          d and len(d["presets"]) == 4, str(d and d["presets"]))
    check("`rootClassName` 真的落在正文的祖先上（否则那两条嵌套样式静默失效）",
          d and d["rootOk"] is True, str(d and d["rootOk"]))
    pg.locator(".ant-modal-wrap:visible .qm-reject-ok").click(force=True)
    pg.wait_for_timeout(400)
    check("理由为空时点主按钮：**一个请求都没发**（禁用不只是个样式）",
          quota_review_posts(pg) == [], str(quota_review_posts(pg)))

    pg.locator(".ant-modal-wrap:visible .qm-reject-preset").first.click()
    pg.wait_for_timeout(200)
    d = pg.evaluate(QUOTA_REJECT_DIALOG)
    check("点预设 ⇒ 文本框里真的有那几个字、按钮随之可用",
          d and d["value"] == d["presets"][0] and d["okDisabled"] is False, str(d))
    # 同一族的计数遮挡（见 §七 那条）：驳回框的正文也是带 showCount 的 TextArea，
    # 底下就是 footer ⇒ 一样要那 22px（`.counter-room`）。
    rj = pg.evaluate("""() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find(
            (w) => getComputedStyle(w).display !== 'none' && w.querySelector('.qm-reject-ok'));
        if (!m) return null;
        const c = m.querySelector('.ant-input-data-count');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        const btn = m.querySelector('.qm-reject-ok').getBoundingClientRect();
        return {text: c.textContent, countBottom: Math.round(r.bottom),
                btnTop: Math.round(btn.top)};
    }""")
    check("驳回框的计数也渲染出来了、且没压在「确认驳回」上",
          bool(rj) and rj["countBottom"] <= rj["btnTop"], str(rj))
    check("**弹窗开着、理由也填好了，仍是一个请求都没发**（点下去才发）",
          quota_review_posts(pg) == [], str(quota_review_posts(pg)))
    pg.locator(".ant-modal-wrap:visible .qm-reject-ok").click()
    pg.wait_for_timeout(900)
    posts = quota_review_posts(pg)
    check("确认后发出 POST /api/protected/quota/requests/9001/review",
          len(posts) == 1 and posts[0]["url"] == "/api/protected/quota/requests/9001/review",
          str(posts))
    check("请求体是 {approved:false, reason:填的那些字}（驳回必带理由）",
          posts and posts[0]["body"] == {"approved": False, "reason": "理由不充分"},
          str(posts[0]["body"] if posts else None))
    _n = notices(pg)
    check("成功提示是后端那句中文", any("已驳回" in x and "guest1" in x for x in _n), str(_n))
    check("裁决成功后**重拉列表**（回包只有一句中文，一个值都没带回来 ⇒ 不许就地更新）",
          len(quota_requests(pg)) >= 2, str(quota_requests(pg)))
    check("这一行从「待处理」里消失了（共 1 条申请）",
          len(quota_rows(pg)) == 1 and "共1条申请" in pg.evaluate(
              "() => document.querySelector('.qm-count').textContent.replace(/\\s+/g, '')"),
          str(quota_rows(pg)))

    # 切到「全部」：三种状态同屏，且已处理的行一条动作都不给
    pg.locator(".qm-tabs button", has_text="全部").first.click()
    pg.wait_for_timeout(500)
    check("切「全部」⇒ 三条都在（这一档的 `status` 也交给服务端）",
          len(quota_rows(pg)) == 3 and quota_requests(pg)[-1].get("status") == "all",
          f'{quota_rows(pg)} {quota_requests(pg)}')
    allrows = quota_rows(pg)
    check("刚驳回那一条现在是「已驳回」并带着驳回理由",
          "已驳回" in allrows[0] and "理由不充分" in allrows[0], allrows[0])
    check("已处理的行不再有动作（status 是三值不是布尔）",
          pg.locator(".qm-scroll .ant-table-row").nth(0).locator(".ant-btn-dangerous").count() == 0,
          str(pg.locator(".qm-scroll .ant-table-row").nth(0).locator(".ant-btn").count()))

    # 批准：清零 + 不可逆，所以要二次确认；确认后 body 是 approved=true 且不带理由
    # ⚠️ "零请求"要比**增量**：这一页此前已经成功发过一条驳回（同一条断言在驳回那
    # 一步能写 `== []`，因为那时还是 0）。写成 `== []` 会恒红——而它红的那句读起来
    # 像"批准弹窗发了请求"，其实是断言自己写错了（分辨成本极高）。
    _n0 = len(quota_review_posts(pg))
    pg.locator(".qm-scroll .ant-table-row").nth(1).locator(".ant-btn-link").first.click()
    pg.wait_for_timeout(300)
    d = pg.evaluate(QUOTA_APPROVE_DIALOG)
    check("点「批准」先弹窗", d is not None, str(d))
    check("主按钮写「批准并恢复满额」（这一下唯一不可逆的那半边）",
          d and d["ok"] == "批准并恢复满额", str(d and d["ok"]))
    check("正文写明恢复到上限、他立刻能问、且撤不回来",
          d and "恢复到上限" in d["body"] and "撤不回来" in d["body"], str(d and d["body"]))
    # 「清零」是**库里的实现**（`chat_quota_used = 0`），不是主人看到的那个东西——
    # 他看到的是递减的余额（20260929 用户指出）。这一条把措辞钉在这里，免得下次
    # 又有谁"顺手"改回计数器口径。
    check("正文里**不出现**「清零」（主人看到的是递减的余额，不是计数器）",
          d and "清零" not in d["body"], str(d and d["body"]))
    # 这一句说的是**已用**（被退掉的那样东西），所以括号里也印已用：沿用列表那列的余额
    # 会读成"退掉的是一部分余额"（申请人已经被拦住了，两句话正好互相打脸）。
    check("括号里印的是**已用**轮数（与「恢复到上限」这句同口径），不是列表那列的余额",
          d and "已用500轮" in d["body"].replace(" ", "") and "剩0/500" not in d["body"],
          str(d and d["body"]))
    check("批准弹窗开着时**没有新增请求**（点下去才发）",
          len(quota_review_posts(pg)) == _n0,
          f'{_n0} → {len(quota_review_posts(pg))}: {quota_review_posts(pg)}')
    pg.locator(".ant-modal-wrap:visible .qm-approve-ok").click()
    pg.wait_for_timeout(900)
    posts = quota_review_posts(pg)
    check("批准发到的是**另一行**（9002）",
          len(posts) == 2 and posts[-1]["url"] == "/api/protected/quota/requests/9002/review",
          str(posts))
    check("批准的请求体是 {approved:true, reason:''}（批准恒不带理由）",
          posts and posts[-1]["body"] == {"approved": True, "reason": ""},
          str(posts[-1]["body"] if posts else None))
    _n = notices(pg)
    check("提示里带上申请人（后端那句中文）", any("已批准" in x and "guest2" in x for x in _n), str(_n))
    check("第九节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 十、删除账号的二次确认（20261001）──────────────────────────────────────
    # 现场（用户原话）：「账号删除竟然没有二次确认功能导致我误删几个账号，增加二次确认」。
    # 这一下是全页**唯一一个点一下就下手的写操作**（其它五个都有受控 Modal），而它偏偏
    # 最不可逆——后端是硬删：`user` 行连同 chat_history/chat_summary/conversation 三张
    # 会话表一起清，没有软删、没有回收站、没有回滚入口。所以判据与第五节的冻结同款三层：
    #   ① 点一下 ⇒ **先弹框**，且框里的字是这一下的动作词（「删除」）＋ danger 极性；
    #   ② **弹窗开着、点取消 ⇒ 零请求**（"取消也要真的取消"是最容易写成样子货的一条）；
    #   ③ 只有点确认才发那一条 DELETE，且发完那一行真的从列表里消失。
    # 第四条是这一节比冻结多出来的：**正文必须写明不可恢复与连带清掉什么**——只说
    # "确定要删除吗"是把一个不可逆操作说成了可逆操作，而这正是用户误删时的处境。
    def del_calls(pg):
        """本页发出的删除请求（DELETE /api/temp-users/<id>）。"""
        return pg.evaluate("""() => window.__calls.filter((c) =>
            c.method === 'DELETE' && /^\\/api\\/temp-users\\/\\d+$/.test(c.url))
            .map((c) => ({ url: c.url, body: c.data }))""")

    pg = mount(br)
    pg.locator(".tu-tabs button", has_text="全部").first.click()
    pg.wait_for_timeout(250)
    n0 = pg.evaluate("() => document.querySelectorAll('.tu-row').length")

    pg.locator('.tu-row:has(strong:text-is("guest1")) .tu-del-btn').click()
    pg.wait_for_timeout(300)
    dlg = pg.evaluate(DEL_DIALOG)
    check("点「删除」是先弹确认框，不是直接下手", dlg is not None, str(dlg))
    check("确认框标题点名是哪个账号（删错了回收不了，标题得写清对象）",
          dlg and "guest1" in dlg["title"], str(dlg and dlg["title"]))
    check("确认按钮上的字是动作词「删除」，不是「确定/OK」",
          dlg and dlg["ok"] == "删除", str(dlg and dlg["ok"]))
    check("确认按钮套 danger（红色 = 不可逆的那一下）",
          dlg and dlg["okDanger"], str(dlg and dlg["okDanger"]))
    check("正文写明了**不可恢复**（只说「确定要删除吗」= 把不可逆说成了可逆）",
          dlg and ("不可恢复" in dlg["body"]), str(dlg and dlg["body"]))
    check("正文写明了连带清掉什么（站内对话记录一起没）",
          dlg and ("对话记录" in dlg["body"] or "会话" in dlg["body"]), str(dlg and dlg["body"]))
    check("正文给了可逆的替代动作（想让他登不进来请改用「冻结」）",
          dlg and "冻结" in dlg["body"], str(dlg and dlg["body"]))
    check("**弹窗开着的时候一条删除请求都没发**（动作必须等那一下确认）",
          del_calls(pg) == [], str(del_calls(pg)))

    pg.locator(".ant-modal-wrap:visible .tu-del-cancel").click()
    pg.wait_for_timeout(300)
    check("点取消：弹窗关掉且**零请求**（没有偷偷把人删掉）",
          pg.evaluate(DEL_DIALOG) is None and del_calls(pg) == [],
          f'dlg={pg.evaluate(DEL_DIALOG)} calls={del_calls(pg)}')

    pg.locator('.tu-row:has(strong:text-is("guest1")) .tu-del-btn').click()
    pg.wait_for_timeout(300)
    pg.locator(".ant-modal-wrap:visible .tu-del-ok").click()
    pg.wait_for_timeout(700)
    calls = del_calls(pg)
    check("确认后发出 DELETE /api/temp-users/100（只这一条）",
          len(calls) == 1 and calls[0]["url"] == "/api/temp-users/100", str(calls))
    check("删除请求没有 body（目标在路径里，别在别处再传一份）",
          calls and calls[0]["body"] is None, str(calls[0]["body"] if calls else None))
    check("删完重新拉了一次列表（不是只在本地把行抹掉）",
          pg.evaluate("() => window.__calls.filter((c) => c.method === 'GET').length") >= 1,
          str(pg.evaluate("() => window.__calls.map((c) => c.method + ' ' + c.url)")))
    g = pg.evaluate(GEO)
    check("删掉的那一行真的从列表里消失了（行数少一）",
          g["rows"] == n0 - 1 and "guest1" not in [r["u"] for r in g["delBtns"]],
          f'{n0} → {g["rows"]}：{[r["u"] for r in g["delBtns"]][:5]}')
    _n = notices(pg)
    check("成功提示是后端那句中文（用户已删除），不是字面量 ok",
          any("用户已删除" in x for x in _n)
          and not any(x.strip().lower() == "ok" for x in _n), str(_n))
    check("第十节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 用户管理页（账号管理 + 评论管理 + 额度管理）：全部通过")
