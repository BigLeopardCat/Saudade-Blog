# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dashboard-users-mobile.spec.ts >> 后台用户管理窄屏 >> 390×844 动作按钮一颗都不许被裁；宽屏不许变；负控两连
- Location: tests/e2e/dashboard-users-mobile.spec.ts:285:3

# Error details

```
Error: 宽屏下账号行仍是**一行**（动作组不换行） → [[237.06,243.06],[311.06,288.06],[361.06,335.06]]（⚠️ 本机无中文字体、度量与原开发机不同，若差 ~20px 红为环境差异，判据不改）

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Page snapshot

```yaml
- generic [ref=f1e4]:
  - navigation [ref=f1e6]:
    - generic [ref=f1e7]:
      - generic [ref=f1e8]: 管理员
      - generic [ref=f1e13] [cursor=pointer]
      - generic [ref=f1e14] [cursor=pointer]
    - generic [ref=f1e15]:
      - generic [ref=f1e16]:
        - listitem [ref=f1e17] [cursor=pointer]:
          - textbox "search..."
        - list [ref=f1e19]:
          - listitem [ref=f1e20]:
            - generic [ref=f1e22]: 主页
          - listitem [ref=f1e23]:
            - generic [ref=f1e25]: 笔记
          - listitem [ref=f1e26]:
            - generic [ref=f1e28]: 说说
          - listitem [ref=f1e29]:
            - generic [ref=f1e31]: 图库
          - listitem [ref=f1e32]:
            - generic [ref=f1e36]: 公告
          - listitem [ref=f1e37]:
            - generic [ref=f1e41]: 用户管理
          - listitem [ref=f1e42]:
            - generic [ref=f1e44]: 数据板
      - generic [ref=f1e45]:
        - listitem [ref=f1e46]:
          - generic [ref=f1e48]: 站点设置
        - listitem [ref=f1e49]:
          - generic [ref=f1e51]: 返回首页
        - listitem [ref=f1e52]:
          - generic [ref=f1e54]: 白日模式
          - generic [ref=f1e55] [cursor=pointer]
  - generic [ref=f1e70]:
    - tablist [ref=f1e71]:
      - generic [ref=f1e73]:
        - tab [selected] [ref=f1e75] [cursor=pointer]:
          - heading "账号管理" [level=3] [ref=f1e76]
        - tab [ref=f1e78] [cursor=pointer]:
          - heading "留言管理" [level=3] [ref=f1e79]
        - tab [ref=f1e81] [cursor=pointer]:
          - heading "评论管理" [level=3] [ref=f1e82]
        - tab [ref=f1e84] [cursor=pointer]:
          - heading "额度管理" [level=3] [ref=f1e85]
    - tabpanel "账号管理" [ref=f1e88]:
      - generic [ref=f1e89]:
        - generic [ref=f1e90]:
          - generic [ref=f1e91]:
            - textbox "用户名" [ref=f1e92]
            - generic [ref=f1e93]:
              - textbox "密码（至少 8 位）" [ref=f1e94]
              - img "eye-invisible" [ref=f1e96] [cursor=pointer]
            - button "新建临时用户" [ref=f1e100] [cursor=pointer]
          - paragraph [ref=f1e102]: 临时用户可登录前台发布说说、放河灯留言（供访客开账号用）
          - generic [ref=f1e103]:
            - tablist [ref=f1e104]:
              - button "全部" [ref=f1e105] [cursor=pointer]
              - button "管理员账号" [ref=f1e106] [cursor=pointer]
              - button "普通用户账号" [ref=f1e107] [cursor=pointer]
              - button "冻结账号" [ref=f1e108] [cursor=pointer]
            - generic [ref=f1e110]:
              - searchbox "检索用户名 / ID…" [ref=f1e112]
              - button [ref=f1e115] [cursor=pointer]:
                - img "search" [ref=f1e117]
            - button "reload 刷新" [ref=f1e120] [cursor=pointer]:
              - img "reload" [ref=f1e122]
              - generic [ref=f1e125]: 刷新
            - generic [ref=f1e126]: 共 3 个账号
        - generic [ref=f1e128]:
          - generic [ref=f1e129]:
            - generic [ref=f1e130]:
              - strong [ref=f1e131]: a_very_long_guest_account_32c
              - generic [ref=f1e132]: 已冻结
              - generic [ref=f1e133]: 已禁言 · 2026-11-01 00:00
              - generic [ref=f1e134]: "ID: 100"
              - text: 额度：剩 1 / 500
            - generic [ref=f1e135]:
              - button "修改密码" [ref=f1e136] [cursor=pointer]
              - button "生成恢复码" [ref=f1e138] [cursor=pointer]
              - button "发通知" [ref=f1e140] [cursor=pointer]
              - button "重置额度" [ref=f1e142] [cursor=pointer]
              - button "解 冻" [ref=f1e144] [cursor=pointer]
              - button "解除禁言" [ref=f1e146] [cursor=pointer]
              - button "变更身份" [ref=f1e148] [cursor=pointer]
              - button "删 除" [ref=f1e150] [cursor=pointer]
          - generic [ref=f1e152]:
            - generic [ref=f1e153]:
              - strong [ref=f1e154]: guest2
              - generic [ref=f1e155]: "ID: 101"
              - text: 额度：剩 497 / 500
            - generic [ref=f1e156]:
              - button "修改密码" [ref=f1e157] [cursor=pointer]
              - button "生成恢复码" [ref=f1e159] [cursor=pointer]
              - button "发通知" [ref=f1e161] [cursor=pointer]
              - button "重置额度" [ref=f1e163] [cursor=pointer]
              - button "冻 结" [ref=f1e165] [cursor=pointer]
              - button "禁 言" [ref=f1e167] [cursor=pointer]
              - button "变更身份" [ref=f1e169] [cursor=pointer]
              - button "删 除" [ref=f1e171] [cursor=pointer]
          - generic [ref=f1e173]:
            - generic [ref=f1e174]:
              - strong [ref=f1e175]: zako_one
              - img "杂鱼" [ref=f1e176]:
                - img [aria-hidden] [ref=f1e177]:
                  - generic [ref=f1e178]: 🐟 杂 鱼 🐟
              - generic [ref=f1e182]: "ID: 102"
              - text: 额度：剩 490 / 500
            - generic [ref=f1e183]:
              - button "修改密码" [ref=f1e184] [cursor=pointer]
              - button "生成恢复码" [ref=f1e186] [cursor=pointer]
              - button "发通知" [ref=f1e188] [cursor=pointer]
              - button "重置额度" [ref=f1e190] [cursor=pointer]
              - button "冻 结" [ref=f1e192] [cursor=pointer]
              - button "禁 言" [ref=f1e194] [cursor=pointer]
              - button "变更身份" [ref=f1e196] [cursor=pointer]
  - button [ref=f1e199]
```

# Test source

```ts
  316 |           token = "superadmin",
  317 |         ) => {
  318 |           const page = await browser.newPage({
  319 |             viewport: { width: size[0], height: size[1] },
  320 |           });
  321 |           const errs = collectPageErrors(page);
  322 |           // token 要在 goto 之前写：Dashboard 壳按它在登录态/未登录态之间分叉。
  323 |           // 必须**每页重设**——localStorage 按源共享，上一节切过的视角会漏到下一节。
  324 |           await page.addInitScript("localStorage.setItem('tokenKey', 'x.y.z');");
  325 |           await page.goto(sb.url);
  326 |           await page.evaluate(
  327 |             (r) =>
  328 |               (
  329 |                 window as unknown as {
  330 |                   __setToken: (r: string) => void;
  331 |                 }
  332 |               ).__setToken(r),
  333 |             token,
  334 |           );
  335 |           await page.reload();
  336 |           await page.waitForSelector(wait, { timeout: 15_000 });
  337 |           // 页面里 loadTempUsers 是 setTimeout 500ms 后才发的
  338 |           await page.waitForTimeout(900);
  339 |           return { page, errs };
  340 |         };
  341 |         const geo = (page: Page): Promise<Geo> => page.evaluate(GEO);
  342 | 
  343 |         // ══ 【一】390×844：动作按钮必须全在列表盒子里 ══
  344 |         {
  345 |           const s1 = await mount();
  346 |           const g = await geo(s1.page);
  347 |           expect(
  348 |             g.rows.length === 3,
  349 |             `账号行渲染出来了（真外壳 + 真页面挂上了） → ${g.rows.length}`,
  350 |           ).toBe(true);
  351 |           expect(
  352 |             g.list !== null && g.list.width < g.innerW - 40,
  353 |             `列表盒子比视口窄（说明真外壳的卡片宽度生效了，沙箱没比线上宽松） → list=${g.list?.width.toFixed(0)} innerW=${g.innerW}`,
  354 |           ).toBe(true);
  355 |           expect(
  356 |             g.docScrollW <= g.innerW + 1,
  357 |             `整页没被撑出横向溢出 → scrollW=${g.docScrollW} ≤ ${g.innerW}+1`,
  358 |           ).toBe(true);
  359 | 
  360 |           // 每行的按钮数：普通账号 8 颗，**非普通账号 7 颗**（`u.role === 'user'` 才给
  361 |           // 「删除」——后端也会拒，前端让按钮干脆不出现，见行上那段注）。这里按角色对账，
  362 |           // 不写死一个数：少了哪一颗都是"展示不全"，只是换了个方向。
  363 |           const counts = g.rows.map((r) => [r.btns[0]?.text, r.btns.length]);
  364 |           expect(
  365 |             JSON.stringify(counts.map((c) => c[1])) === JSON.stringify([8, 8, 7]),
  366 |             `每行都渲染出该有的动作按钮（普通账号 8 / 杂鱼 7，差的那颗是「删除」） → ${JSON.stringify(counts)}`,
  367 |           ).toBe(true);
  368 |           // ⚠️ 这一条**不是**主判据，它只是用来把主判据衬托出来：被 `.tu-list` 裁掉的按钮
  369 |           // `offsetParent` 照样非空（它没被 `display:none`），所以"按钮存在/可见"永远绿。
  370 |           const hidden = g.rows.flatMap((r, i) =>
  371 |             r.btns.filter((b) => !b.visible).map((b) => [i, b.text]),
  372 |           );
  373 |           expect(
  374 |             hidden.length === 0,
  375 |             `（陪衬）每颗按钮 offsetParent 都非空——被裁的那几颗也照样非空，所以这一条永远绿，真正的判据只能是几何 → ${JSON.stringify(hidden)}`,
  376 |           ).toBe(true);
  377 | 
  378 |           // ★ 本套件的主判据
  379 |           const bad = clipFails(g);
  380 |           expect(
  381 |             bad.length === 0,
  382 |             `★ 每颗按钮的左右缘都落在列表盒子内（用户报的「右侧被截断」） → ${bad.slice(0, 4).join("; ")}${bad.length > 4 ? " …" : ""}`,
  383 |           ).toBe(true);
  384 |           const over = g.rows
  385 |             .filter((r) => r.scrollW > r.clientW + 1)
  386 |             .map((r, i) => `行${i}: ${r.scrollW}>${r.clientW}`);
  387 |           expect(
  388 |             over.length === 0,
  389 |             `★ 没有哪一行的内容比行盒宽（溢出即使被裁也是缺陷） → ${over.join("; ")}`,
  390 |           ).toBe(true);
  391 | 
  392 |           // 这一条是"修法选对了没有"：窄屏下动作组该**换到自己的行**，而不是继续挤
  393 |           if (g.rows.length > 0) {
  394 |             const r0 = g.rows[0];
  395 |             expect(
  396 |               r0.actions!.top >= r0.info!.bottom - 1,
  397 |               `窄屏下动作组换到了信息行之下 → actions.top=${r0.actions!.top.toFixed(0)} ≥ info.bottom=${r0.info!.bottom.toFixed(0)}`,
  398 |             ).toBe(true);
  399 |           }
  400 |           expect(
  401 |             s1.errs().length === 0,
  402 |             `全程无页面异常 → ${s1.errs().slice(0, 3).join("; ")}`,
  403 |           ).toBe(true);
  404 |           await s1.page.close();
  405 |         }
  406 | 
  407 |         // ══ 【二】宽屏对照：一个像素都不许变 ══
  408 |         {
  409 |           const s2 = await mount([DW, DH]);
  410 |           const g = await geo(s2.page);
  411 |           const rowsOneLine = g.rows.every((r) => r.actions!.top < r.info!.bottom - 4);
  412 |           const detail = g.rows.map((r) => [r.info!.bottom, r.actions!.top]);
  413 |           expect(
  414 |             rowsOneLine,
  415 |             `宽屏下账号行仍是**一行**（动作组不换行） → ${JSON.stringify(detail)}（⚠️ 本机无中文字体、度量与原开发机不同，若差 ~20px 红为环境差异，判据不改）`,
> 416 |           ).toBe(true);
      |             ^ Error: 宽屏下账号行仍是**一行**（动作组不换行） → [[237.06,243.06],[311.06,288.06],[361.06,335.06]]（⚠️ 本机无中文字体、度量与原开发机不同，若差 ~20px 红为环境差异，判据不改）
  417 |           const bad = clipFails(g);
  418 |           expect(
  419 |             bad.length === 0,
  420 |             `宽屏下也没有按钮越界 → ${bad.slice(0, 4).join("; ")}`,
  421 |           ).toBe(true);
  422 |           expect(
  423 |             g.rows.every((r) => r.scrollW <= r.clientW + 1),
  424 |             "宽屏下没有行内容溢出",
  425 |           ).toBe(true);
  426 |           await s2.page.close();
  427 |         }
  428 | 
  429 |         // ══ 【三】负控：判据自己得先被证明是敏感的 ══
  430 |         // 把当年的坏形状（不换行）假回去 —— 主判据必须当场转红，否则它可能只是恒真。
  431 |         {
  432 |           const nc = await mount();
  433 |           await nc.page.evaluate(() => {
  434 |             const s = document.createElement("style");
  435 |             s.textContent =
  436 |               ".tu-row{flex-wrap:nowrap!important}" +
  437 |               ".tu-actions{flex-wrap:nowrap!important}";
  438 |             document.head.appendChild(s);
  439 |           });
  440 |           await nc.page.waitForTimeout(120);
  441 |           const g = await geo(nc.page);
  442 |           const fails = clipFails(g);
  443 |           expect(
  444 |             fails.length > 0,
  445 |             `负控①：假回 \`nowrap\` ⇒ 「每颗按钮都在列表盒子内」会红 → 越界 ${fails.length} 处`,
  446 |           ).toBe(true);
  447 |           expect(
  448 |             g.rows.some((r) => r.scrollW > r.clientW + 1),
  449 |             "负控①：同一手也让行内容比行盒宽 ⇒ 那条溢出判据会红",
  450 |           ).toBe(true);
  451 |           await nc.page.close();
  452 |         }
  453 | 
  454 |         // 负控②：把**线上那个坏形状整套**假回去（`nowrap` + 列表的 `overflow: hidden`），
  455 |         // 再单独摘掉 `hidden` 那一半 ⇒ 溢出改由外层 `.tu-list-wrap`（本来就是 `overflow: auto`）
  456 |         // **横滚**接住。这条量的是"那个 hidden 当初在替我们做什么"：它把"滚一滚还够得着"
  457 |         // 换成了"根本够不着"。
  458 |         // ⚠️ 两条走过的弯路都留在这儿：
  459 |         //   · 只摘 `hidden`、不假回 `nowrap` —— 修完之后**没有溢出可接**，
  460 |         //     `wrap.scrollWidth == clientWidth` 恒成立，这条控制永远红（控制本身失效了，
  461 |         //     它验的是修之前的机制，就得把修之前那半也一起假回去）；
  462 |         //   · 第一版写的是"整页被撑宽" —— 实测是**假的**：`.tu-list-wrap` 是滚动容器，
  463 |         //     溢出被它吸收了，页面永远不会变宽。判据问错了对象时就是这样：恒红，
  464 |         //     而红的原因是它问的那件事本来就不成立。
  465 |         {
  466 |           const nc = await mount();
  467 |           await nc.page.evaluate(() => {
  468 |             const s = document.createElement("style");
  469 |             s.textContent =
  470 |               ".tu-row{flex-wrap:nowrap!important}" +
  471 |               ".tu-actions{flex-wrap:nowrap!important}";
  472 |             document.head.appendChild(s);
  473 |             (document.querySelector(".tu-list") as HTMLElement).style.overflow =
  474 |               "visible";
  475 |           });
  476 |           await nc.page.waitForTimeout(120);
  477 |           const g = await geo(nc.page);
  478 |           expect(
  479 |             g.wrapScrollW! > g.wrapClientW! + 1,
  480 |             `负控②：假回线上那套坏形状再摘掉 \`overflow: hidden\` ⇒ 溢出改由 \`.tu-list-wrap\` 横滚接住（正是那个 hidden 把「够得着」变成了「够不着」） → wrap scrollW=${g.wrapScrollW} clientW=${g.wrapClientW}`,
  481 |           ).toBe(true);
  482 |           await nc.page.close();
  483 |         }
  484 |       },
  485 |     );
  486 |   });
  487 | });
  488 | 
```