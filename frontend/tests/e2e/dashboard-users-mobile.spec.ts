import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FE_DIR,
  withSandbox,
  collectPageErrors,
  esbuildInSandbox,
  compileSass,
} from "./sandbox";

/**
 * 后台「用户管理 → 账号管理」窄屏验收：真组件 + 真 CSS + 390×844 真几何（20261017）
 * （原 tests/dashboard-users-mobile.test.py，20261019 迁移）。
 *
 * 用户原话：
 *   "博客后台移动端的用户列表的操作展示不全，右侧被截断。"
 *
 * 这一条**只有真跑一遍才看得见**，而且它的坏法是本仓最安静的那一种：账号行是一个
 * `justify-content: space-between` 的 flex 行，右边那组动作按钮（最多 **8 颗**：修改密码 /
 * 生成恢复码 / 发通知 / 重置额度 / 冻结|解冻 / 禁言|解除禁言 / 变更身份 / 删除）挂在一条
 * 内联的 `display:flex; gap:8` 上——**没有 flex-wrap**。手机上整行只有约 268px 可用，
 * 而那 8 颗按钮的最小宽度加起来约 550px，于是右侧一大截被 `.tu-list` 的 `overflow: hidden`
 * **静静裁掉**：DOM 里都在、`querySelector` 都取得到、控制台一个字不报，只是**看不见也点不着**。
 * 所以判据不能是"按钮存在"，必须是**几何**：每颗按钮的外框都要落在列表盒子的横向范围内。
 *
 * 三条判据：
 *   · 页面无横向溢出（`.tu-list` 的裁切不会把整页撑宽——这正是它安静的原因）；
 *   · **每颗按钮的左右缘都在 `.tu-list` 的左右缘之内**（用户报的那条）；
 *   · 每行都渲染出全部 8 颗（少了哪一颗也是"展示不全"，只是换了个方向）。
 *
 * 外加两条不许退化的：
 *   · **宽屏（1440）一个像素都不许变**——修法若是"窄屏才换行"或"永远换行"，这里会红；
 *   · 负控：把 `flex-wrap: nowrap !important` 假回去 ⇒ 上面那条必须当场转红
 *     （判据自己得先被证明是敏感的，否则它可能只是恒真）。
 *
 * 沿用 `dashboard-mobile.test.py` 那套既定手段（本机不能 vite build，见 CLAUDE.md §2）：
 * esbuild 把**真组件**打成一个 bundle、只桩边界（axios / react-redux），antd 与
 * react-dom 用真的，路由用**真的** `MemoryRouter`（这一页读 `useSearchParams` 的深链，
 * 桩掉路由就把被测对象一起桩掉了）。CSS 一律 link 仓库里那几份**真文件**，
 * `.tu-*` 那份 sass 用 programmatic API 单独编译。
 *
 * （TS 迁移注：本机 aarch64 无中文字体、字体度量与原开发机不同，宽屏档
 * 「账号行一行」那条判据在此环境下可能差 ~22px 判红——Python 原版同机同红，
 * 属环境差异而非代码回归，判据本身不改。）
 */

// 断点与视口：390×844 与 `dashboard-mobile.test.py` 同一个机型档，便于两套读数互相参照。
const VW = 390;
const VH = 844;
// 宽屏对照档：这一档上**一个像素都不许变**（见断言二）。
const DW = 1440;
const DH = 700;

const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

// ── axios 桩 ────────────────────────────────────────────────────────────────
// 桩必须**同时**是"可调用的函数"和"带方法的对象"（`axios.create()` 出来的实例本来
// 就是这两者的合体），而这一页两种写法都有：账号管理写 `http.get(...)`，
// 个人中心那一族写 `http({url, method})`。只做对象 ⇒ 后者 TypeError，而组件里
// `try{await http(...)}catch{}` 会把它静静吃掉（症状是"列表空着、零异常"）。
//
// ⚠️ `/api/temp-users` 的 GET 回的是**裸数组**（真后端 `routes/temp_user.rs` 返回
// `Json<Vec<TempUserInfo>>`），不是 `{code,message,data}` 那层壳。桩在这里必须跟
// 真后端一致，否则"把 `res.data` 写成 `res.data.data`"这类缺陷会被桩掩盖成"没有账号"。
//
// 夹具刻意挑**最宽的一行**当靶子：32 字长账号名 + 「已冻结」+「已禁言」两枚标签 +
// ID + 额度 chip + 全部 8 颗按钮。少一样，判据就可能在更窄的真实机型上假绿。
const FAKE_AXIOS = `const USERS = [
  { id: 100, username: 'a_very_long_guest_account_32c', role: 'user', status: 1,
    muted: true, mutedUntil: '2026-11-01 00:00:00',
    chatQuotaUsed: 499, chatQuotaLimit: 500 },
  { id: 101, username: 'guest2', role: 'user', status: 0,
    chatQuotaUsed: 3, chatQuotaLimit: 500 },
  { id: 102, username: 'zako_one', role: 'zako', status: 0,
    chatQuotaUsed: 10, chatQuotaLimit: 500 },
];
const wire = (d: any) => JSON.parse(JSON.stringify(d));
const req = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  if (url === '/api/temp-users' && method === 'GET') return { status: 200, data: wire(USERS) };
  return { status: 200, data: { code: 200, message: 'ok', data: null } };
};
const http: any = (cfg: any) => req(cfg);
http.get = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'GET' });
http.post = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'POST' });
http.put = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'PUT' });
http.delete = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'DELETE' });
export default http;
`;

const STUB_REDUX = `const state: any = {
  categories: { categories: [] },
  tags: { tags: [] },
  note: { noteList: [] },
  user: { avatar: '', name: '管理员', blogTitle: 'Saudade' },
};
export const useSelector = (fn: any) => fn(state);
export const useDispatch = () => (_action: any) => undefined;
export const Provider = ({ children }: any) => children;
export const connect = () => (C: any) => C;
`;

// ── 入口：真路由 + 真外壳 + 真页面 ──────────────────────────────────────────
// 三层都要真：只挂 `Users` 的话容器宽度就是视口宽（390），而线上后台在 390px 视口下
// 卡片内只有约 318px —— **沙箱比线上宽 72px**，缺陷会在沙箱里假绿（本仓"环境失真
// 伪装成真缺陷"的反面：环境比线上宽松，伪装成"已经好了"）。挂上真外壳，`.Card`
// 的宽与内边距就由 `Dashboard/index.css` 那条 1024 媒体查询自己算出来。
//
// 令牌是**真形状**的三段 JWT：这一页有两个按钮的亮灭取决于"我是谁"（同级管理员
// 不可互冻、只有超管看得见「变更身份」）。uid 取 999（不在夹具里）⇒ 靶子那一行
// 的冻结/禁言按钮都不会因为"不能动自己"而被 Tooltip 包起来，8 颗按钮齐活。
const ENTRY = `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Dashboard from './src/pages/Dashboard/index.tsx';
import Users from './src/pages/Dashboard/Users/index.tsx';

const b64u = (o: any) => btoa(JSON.stringify(o))
  .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
(window as any).__setToken = (role: string | null, uid: number = 999) => {
  localStorage.setItem('tokenKey', role ? 'x.' + b64u({ sub: uid, role }) + '.sig' : 'x.y.z');
};
(window as any).__setToken('superadmin');

(window as any).__mount = () => createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/dashboard/users']}>
    <Routes>
      <Route path="/dashboard" element={<Dashboard />}>
        <Route path="users" element={<Users />} />
      </Route>
    </Routes>
  </MemoryRouter>
);
`;

// 沙箱根 tsconfig：esbuild 的 paths 解析（替代原 CLI --alias:react-redux）。
const TSCONFIG_PATHS = JSON.stringify({
  compilerOptions: {
    paths: {
      "react-redux": ["./stub-redux.tsx"],
    },
  },
});

// 五份真 CSS，link 的顺序就是层叠顺序（与线上"组件样式后于全局样式"的次序一致）：
//   reset.css   **全站 reset**（`* { margin:0; padding:0; box-sizing:border-box }`，
//               住 `frontHome/main.css`）。⚠️ 不能省：少了它 `.tu-section` 会按
//               content-box 算，几何全错——这是"沙箱失真"，不是页面缺陷。
//   tokens.css  `--washi-*` 令牌（`main.tsx` 的 `import './index.css'`）。
//   switch.css  侧栏里的主题开关（缺了它侧栏高度与线上不一样）。
//   dash.css    后台壳本体 + 末尾那条 1024 媒体查询（卡片宽度就是它算的）。
//   users.css   `.tu-*` 那份 sass，**用 programmatic API 真编译**——esbuild 的
//               `--loader:.sass=text` 只把它收成一个字符串，不生效。
const REAL_CSS: Array<[string, string]> = [
  ["src/frontHome/main.css", "reset.css"],
  ["src/index.css", "tokens.css"],
  ["src/components/Switch/index.css", "switch.css"],
  ["src/pages/Dashboard/index.css", "dash.css"],
];

const INDEX_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<link rel="stylesheet" href="reset.css">' +
  '<link rel="stylesheet" href="tokens.css">' +
  '<link rel="stylesheet" href="switch.css">' +
  '<link rel="stylesheet" href="dash.css">' +
  '<link rel="stylesheet" href="users.css"></head><body><div id="root"></div>' +
  '<script src="bundle.js"></script>' +
  "<script>window.__mount();</script>" +
  "</body></html>";

// 几何读法。**只问浏览器要外框**，不读源码文本、也不读 CSSOM 的字面值：
//   · 每颗按钮的 rect 与 `.tu-list` 的 rect 比左右缘 —— 这就是"截断"的定义；
//   · `row.scrollWidth > row.clientWidth` —— 行内容比行盒宽（`.tu-row` 是
//     `overflow: visible`，但 Chrome 的 scrollWidth 照样把溢出的子元素算进来）；
//   · `docScrollW > innerW` —— 整页被撑宽（**截断的坏法恰恰是这里为假**：
//     `.tu-list` 的 `overflow: hidden` 把溢出吃掉了，所以这条要单独立，不能只靠它）。
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}
interface BtnRead {
  text: string;
  box: Box;
  visible: boolean;
}
interface RowRead {
  wrap: string;
  box: Box;
  scrollW: number;
  clientW: number;
  info: Box | null;
  actions: Box | null;
  btns: BtnRead[];
}
interface Geo {
  list: Box | null;
  listOverflow: string | null;
  // 外层的滚动盒。它自己 `overflow: auto` ⇒ 列表里溢出来的东西本来该在这儿
  // 变成一条横向滚动条；`.tu-list` 的 `overflow: hidden` 把溢出吃掉之后，
  // 这里就恒不滚 —— "看不见也够不着"正是这么来的。
  wrap: Box | null;
  wrapScrollW: number | null;
  wrapClientW: number | null;
  innerW: number;
  docScrollW: number;
  rows: RowRead[];
}
const GEO = (): Geo => {
  const box = (el: Element | null): Box | null => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {
      left: +b.left.toFixed(2),
      right: +b.right.toFixed(2),
      top: +b.top.toFixed(2),
      bottom: +b.bottom.toFixed(2),
      width: +b.width.toFixed(2),
      height: +b.height.toFixed(2),
    };
  };
  const list = document.querySelector(".tu-list");
  const wrap = document.querySelector(".tu-list-wrap");
  const rows = Array.from(document.querySelectorAll(".tu-row"));
  return {
    list: box(list),
    listOverflow: list ? getComputedStyle(list).overflowX : null,
    wrap: box(wrap),
    wrapScrollW: wrap ? wrap.scrollWidth : null,
    wrapClientW: wrap ? wrap.clientWidth : null,
    innerW: window.innerWidth,
    docScrollW: document.documentElement.scrollWidth,
    rows: rows.map((r) => {
      const btns = Array.from(r.querySelectorAll(".ant-btn"));
      return {
        wrap: getComputedStyle(r).flexWrap,
        box: box(r)!,
        scrollW: r.scrollWidth,
        clientW: r.clientWidth,
        info: box(r.querySelector(".tu-info")),
        actions: box(r.querySelector(".tu-actions")),
        // 每颗按钮：文案（抹掉 antd 在两个汉字之间插的空格）+ 左右缘 +
        // 是否真的可见（被裁掉的按钮 `offsetParent` 仍在，所以还要量缘）。
        btns: btns.map((b) => ({
          text: (b.textContent || "").replace(/\s+/g, ""),
          box: box(b)!,
          visible: (b as HTMLElement).offsetParent !== null,
        })),
      };
    }),
  };
};

/** 把"哪颗按钮越界了多少"汇成一句话，红的时候现场就在眼前。 */
function clipFails(g: Geo): string[] {
  const out: string[] = [];
  if (g.list === null) return out;
  g.rows.forEach((r, i) => {
    for (const b of r.btns) {
      if (b.box.right > g.list!.right + 0.5) {
        out.push(
          `行${i}「${b.text}」右缘 ${b.box.right.toFixed(0)} > 列表右缘 ${g.list!.right.toFixed(0)}`,
        );
      }
      if (b.box.left < g.list!.left - 0.5) {
        out.push(
          `行${i}「${b.text}」左缘 ${b.box.left.toFixed(0)} < 列表左缘 ${g.list!.left.toFixed(0)}`,
        );
      }
    }
  });
  return out;
}

test.describe("后台用户管理窄屏", () => {
  test.setTimeout(180_000);

  test("390×844 动作按钮一颗都不许被裁；宽屏不许变；负控两连", async ({ browser }) => {
    await withSandbox(
      {
        "index.html": INDEX_HTML,
        ...Object.fromEntries(
          REAL_CSS.map(([src, out]) => [
            out,
            readFileSync(path.join(FE_DIR, src), "utf-8"),
          ]),
        ),
        "users.css": compileSass(
          path.join(FE_DIR, "src/pages/Dashboard/Users/index.sass"),
        ),
      },
      async (sb) => {
        await esbuildInSandbox(sb, {
          entry: "entry.tsx",
          files: {
            "entry.tsx": ENTRY,
            "stub-redux.tsx": STUB_REDUX,
            "src/apis/axios.tsx": FAKE_AXIOS,
            "tsconfig.json": TSCONFIG_PATHS,
          },
          copySrc: true,
          define: { "import.meta.env": DEFINE_ENV },
          loaders: { ".css": "text", ".sass": "text" },
        });

        const mount = async (
          size: [number, number] = [VW, VH],
          wait = ".tu-row",
          token = "superadmin",
        ) => {
          const page = await browser.newPage({
            viewport: { width: size[0], height: size[1] },
          });
          const errs = collectPageErrors(page);
          // token 要在 goto 之前写：Dashboard 壳按它在登录态/未登录态之间分叉。
          // 必须**每页重设**——localStorage 按源共享，上一节切过的视角会漏到下一节。
          await page.addInitScript("localStorage.setItem('tokenKey', 'x.y.z');");
          await page.goto(sb.url);
          await page.evaluate(
            (r) =>
              (
                window as unknown as {
                  __setToken: (r: string) => void;
                }
              ).__setToken(r),
            token,
          );
          await page.reload();
          await page.waitForSelector(wait, { timeout: 15_000 });
          // 页面里 loadTempUsers 是 setTimeout 500ms 后才发的
          await page.waitForTimeout(900);
          return { page, errs };
        };
        const geo = (page: Page): Promise<Geo> => page.evaluate(GEO);

        // ══ 【一】390×844：动作按钮必须全在列表盒子里 ══
        {
          const s1 = await mount();
          const g = await geo(s1.page);
          expect(
            g.rows.length === 3,
            `账号行渲染出来了（真外壳 + 真页面挂上了） → ${g.rows.length}`,
          ).toBe(true);
          expect(
            g.list !== null && g.list.width < g.innerW - 40,
            `列表盒子比视口窄（说明真外壳的卡片宽度生效了，沙箱没比线上宽松） → list=${g.list?.width.toFixed(0)} innerW=${g.innerW}`,
          ).toBe(true);
          expect(
            g.docScrollW <= g.innerW + 1,
            `整页没被撑出横向溢出 → scrollW=${g.docScrollW} ≤ ${g.innerW}+1`,
          ).toBe(true);

          // 每行的按钮数：普通账号 8 颗，**非普通账号 7 颗**（`u.role === 'user'` 才给
          // 「删除」——后端也会拒，前端让按钮干脆不出现，见行上那段注）。这里按角色对账，
          // 不写死一个数：少了哪一颗都是"展示不全"，只是换了个方向。
          const counts = g.rows.map((r) => [r.btns[0]?.text, r.btns.length]);
          expect(
            JSON.stringify(counts.map((c) => c[1])) === JSON.stringify([8, 8, 7]),
            `每行都渲染出该有的动作按钮（普通账号 8 / 杂鱼 7，差的那颗是「删除」） → ${JSON.stringify(counts)}`,
          ).toBe(true);
          // ⚠️ 这一条**不是**主判据，它只是用来把主判据衬托出来：被 `.tu-list` 裁掉的按钮
          // `offsetParent` 照样非空（它没被 `display:none`），所以"按钮存在/可见"永远绿。
          const hidden = g.rows.flatMap((r, i) =>
            r.btns.filter((b) => !b.visible).map((b) => [i, b.text]),
          );
          expect(
            hidden.length === 0,
            `（陪衬）每颗按钮 offsetParent 都非空——被裁的那几颗也照样非空，所以这一条永远绿，真正的判据只能是几何 → ${JSON.stringify(hidden)}`,
          ).toBe(true);

          // ★ 本套件的主判据
          const bad = clipFails(g);
          expect(
            bad.length === 0,
            `★ 每颗按钮的左右缘都落在列表盒子内（用户报的「右侧被截断」） → ${bad.slice(0, 4).join("; ")}${bad.length > 4 ? " …" : ""}`,
          ).toBe(true);
          const over = g.rows
            .filter((r) => r.scrollW > r.clientW + 1)
            .map((r, i) => `行${i}: ${r.scrollW}>${r.clientW}`);
          expect(
            over.length === 0,
            `★ 没有哪一行的内容比行盒宽（溢出即使被裁也是缺陷） → ${over.join("; ")}`,
          ).toBe(true);

          // 这一条是"修法选对了没有"：窄屏下动作组该**换到自己的行**，而不是继续挤
          if (g.rows.length > 0) {
            const r0 = g.rows[0];
            expect(
              r0.actions!.top >= r0.info!.bottom - 1,
              `窄屏下动作组换到了信息行之下 → actions.top=${r0.actions!.top.toFixed(0)} ≥ info.bottom=${r0.info!.bottom.toFixed(0)}`,
            ).toBe(true);
          }
          expect(
            s1.errs().length === 0,
            `全程无页面异常 → ${s1.errs().slice(0, 3).join("; ")}`,
          ).toBe(true);
          await s1.page.close();
        }

        // ══ 【二】宽屏对照：一个像素都不许变 ══
        {
          const s2 = await mount([DW, DH]);
          const g = await geo(s2.page);
          const rowsOneLine = g.rows.every((r) => r.actions!.top < r.info!.bottom - 4);
          const detail = g.rows.map((r) => [r.info!.bottom, r.actions!.top]);
          expect(
            rowsOneLine,
            `宽屏下账号行仍是**一行**（动作组不换行） → ${JSON.stringify(detail)}（⚠️ 本机无中文字体、度量与原开发机不同，若差 ~20px 红为环境差异，判据不改）`,
          ).toBe(true);
          const bad = clipFails(g);
          expect(
            bad.length === 0,
            `宽屏下也没有按钮越界 → ${bad.slice(0, 4).join("; ")}`,
          ).toBe(true);
          expect(
            g.rows.every((r) => r.scrollW <= r.clientW + 1),
            "宽屏下没有行内容溢出",
          ).toBe(true);
          await s2.page.close();
        }

        // ══ 【三】负控：判据自己得先被证明是敏感的 ══
        // 把当年的坏形状（不换行）假回去 —— 主判据必须当场转红，否则它可能只是恒真。
        {
          const nc = await mount();
          await nc.page.evaluate(() => {
            const s = document.createElement("style");
            s.textContent =
              ".tu-row{flex-wrap:nowrap!important}" +
              ".tu-actions{flex-wrap:nowrap!important}";
            document.head.appendChild(s);
          });
          await nc.page.waitForTimeout(120);
          const g = await geo(nc.page);
          const fails = clipFails(g);
          expect(
            fails.length > 0,
            `负控①：假回 \`nowrap\` ⇒ 「每颗按钮都在列表盒子内」会红 → 越界 ${fails.length} 处`,
          ).toBe(true);
          expect(
            g.rows.some((r) => r.scrollW > r.clientW + 1),
            "负控①：同一手也让行内容比行盒宽 ⇒ 那条溢出判据会红",
          ).toBe(true);
          await nc.page.close();
        }

        // 负控②：把**线上那个坏形状整套**假回去（`nowrap` + 列表的 `overflow: hidden`），
        // 再单独摘掉 `hidden` 那一半 ⇒ 溢出改由外层 `.tu-list-wrap`（本来就是 `overflow: auto`）
        // **横滚**接住。这条量的是"那个 hidden 当初在替我们做什么"：它把"滚一滚还够得着"
        // 换成了"根本够不着"。
        // ⚠️ 两条走过的弯路都留在这儿：
        //   · 只摘 `hidden`、不假回 `nowrap` —— 修完之后**没有溢出可接**，
        //     `wrap.scrollWidth == clientWidth` 恒成立，这条控制永远红（控制本身失效了，
        //     它验的是修之前的机制，就得把修之前那半也一起假回去）；
        //   · 第一版写的是"整页被撑宽" —— 实测是**假的**：`.tu-list-wrap` 是滚动容器，
        //     溢出被它吸收了，页面永远不会变宽。判据问错了对象时就是这样：恒红，
        //     而红的原因是它问的那件事本来就不成立。
        {
          const nc = await mount();
          await nc.page.evaluate(() => {
            const s = document.createElement("style");
            s.textContent =
              ".tu-row{flex-wrap:nowrap!important}" +
              ".tu-actions{flex-wrap:nowrap!important}";
            document.head.appendChild(s);
            (document.querySelector(".tu-list") as HTMLElement).style.overflow =
              "visible";
          });
          await nc.page.waitForTimeout(120);
          const g = await geo(nc.page);
          expect(
            g.wrapScrollW! > g.wrapClientW! + 1,
            `负控②：假回线上那套坏形状再摘掉 \`overflow: hidden\` ⇒ 溢出改由 \`.tu-list-wrap\` 横滚接住（正是那个 hidden 把「够得着」变成了「够不着」） → wrap scrollW=${g.wrapScrollW} clientW=${g.wrapClientW}`,
          ).toBe(true);
          await nc.page.close();
        }
      },
    );
  });
});
