# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: article-card-stats.spec.ts >> 文章卡片读数几何 >> 位置/零成本/预算/夜间/桌面同行/手机换行/顺序/标签长高（64 条判据）
- Location: tests/e2e/article-card-stats.spec.ts:331:3

# Error details

```
Error: 卡片高 510px = 内容自然高（下限 470 不参与；封面 200 是 20261001 新值） → card h=515（本机无中文字体，Python 原版同红 515，环境差异）

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

```
Error: 3 个标签（1 行）+ 3 行标题：按内容高 542px（不是被下限硬撑出来的数） → card h=547（本机无中文字体，Python 原版同红 547，环境差异）

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Page snapshot

```yaml
- generic [ref=e8] [cursor=pointer]:
  - generic [ref=e9]:
    - heading "# 编程" [level=4] [ref=e10]
    - generic [ref=e11]:
      - generic "阅读量" [ref=e12]: "12"
      - generic "点赞数" [ref=e17]: "3"
      - generic "收藏数" [ref=e21]: "1"
      - generic "讨论数" [ref=e25]: "8"
  - heading "从零把站内对话助手接进个人博客：规划器、执行器与质检闸的完整记录（下篇）" [level=3] [ref=e29]
  - paragraph [ref=e31]: 这一段是摘要，按最坏情况写满三行：讲的是为什么把执行器做成确定性的、为什么叙述者不绑工具、以及验收为什么必须由回执驱动而不是由模型自述，最后附带一串踩坑清单与回归锁的清单与取舍。
  - generic [ref=e32]:
    - generic [ref=e33]:
      - generic [ref=e34]: 标签0
      - generic [ref=e35]: 标签1
      - generic [ref=e36]: 标签2
    - generic [ref=e37]:
      - generic [ref=e39]: 林陌青川
      - generic [ref=e40]:
        - generic [ref=e41]: 发布于 2026-09-30
        - generic [ref=e42]: 更新于 2026-09-30
```

# Test source

```ts
  540 |         for (const [label, m] of [["短名", ms], ["长名", ml]] as const) {
  541 |           expect.soft(
  542 |             m.stats!.top - m.cat.top > 12,
  543 |             `手机 ${label}卡：读数在分类**下方**（不再是同一行） → stats.top ${m.stats!.top} / cat.top ${m.cat.top}`,
  544 |           ).toBe(true);
  545 |         }
  546 |         expect.soft(
  547 |           Math.abs(ms.stats!.top - ms.cat.top - (ml.stats!.top - ml.cat.top)) < 1,
  548 |           `两张卡的相对位置完全一致（同屏不再混排） → 间距 ${ms.stats!.top - ms.cat.top} vs ${ml.stats!.top - ml.cat.top}`,
  549 |         ).toBe(true);
  550 |         expect.soft(
  551 |           Math.abs(ms.card.h - ml.card.h) < 1 && Math.abs(ms.card.w - ml.card.w) < 1,
  552 |           `两张卡等高且同宽（用户报的'参差'就是这个） → 高 ${ms.card.h} vs ${ml.card.h}／宽 ${ms.card.w} vs ${ml.card.w}`,
  553 |         ).toBe(true);
  554 |         expect.soft(
  555 |           Math.abs(ml.stats!.w - on.stats!.w) < 1,
  556 |           `手机档的读数块与桌面同宽（没被压扁） → ${ml.stats!.w} vs 桌面 ${on.stats!.w}`,
  557 |         ).toBe(true);
  558 |         expect.soft(
  559 |           !ml.catClipped && Math.abs(ml.cat.w - ml.head.w) < 1,
  560 |           `手机档分类名拿满**整行宽**（stretch 生效，且真实长名放得下不被截） → clipped=${ml.catClipped} / cat w=${ml.cat.w} / head w=${ml.head.w}`,
  561 |         ).toBe(true);
  562 |         expect.soft(
  563 |           Math.abs(ms.stats!.left - ms.cat.left) < 1,
  564 |           `读数左对齐于分类名（同一列基准，不是居中的） → stats.left ${ms.stats!.left} / cat.left ${ms.cat.left}`,
  565 |         ).toBe(true);
  566 |         expect.soft(
  567 |           ml.cellCount === 4 && !ms.pageOverflow && !ml.pageOverflow,
  568 |           `四个数都在、且页面不出现横向滚动 → ${ml.cellCount} / ${ml.pageOverflow}`,
  569 |         ).toBe(true);
  570 |         await page.setViewportSize({ width: 1280, height: 900 });
  571 | 
  572 |         // ── ⑥ 四个数：顺序、数值、图标尺寸 ──
  573 |         expect.soft(
  574 |           JSON.stringify(on.cellTexts) === JSON.stringify(["12", "3", "1", "8"]),
  575 |           `顺序恒为 阅读 → 点赞 → 收藏 → 讨论 → ${JSON.stringify(on.cellTexts)}`,
  576 |         ).toBe(true);
  577 |         expect.soft(
  578 |           !!on.svgSize &&
  579 |             Math.abs(on.svgSize.w - 13) < 0.6 &&
  580 |             Math.abs(on.svgSize.h - 13) < 0.6,
  581 |           `图标是 svg 且 13×13 → ${JSON.stringify(on.svgSize)}`,
  582 |         ).toBe(true);
  583 |         {
  584 |           const titles = await page.evaluate(() =>
  585 |             [...document.querySelectorAll(".ArticleStat")].map(
  586 |               (e) => (e as HTMLElement).title,
  587 |             ),
  588 |           );
  589 |           expect.soft(
  590 |             JSON.stringify(titles) ===
  591 |               JSON.stringify(["阅读量", "点赞数", "收藏数", "讨论数"]),
  592 |             `四个格子都有 title（悬停说明：阅读量/点赞数/收藏数/讨论数） → ${JSON.stringify(titles)}`,
  593 |           ).toBe(true);
  594 |         }
  595 | 
  596 |         // ── ⑦ ★ 标签换行：卡片按内容长高，页脚与「更新于」都不许被切掉（20260930 现场） ──
  597 |         // 用户原话："在文章标签变成两行时，作者信息时间信息在卡片的位置还是没锁死，跑出卡片了"。
  598 |         // 定高 600px 时 3 行标题 + 标签第三行就把「更新于」顶到卡底下方 19px（只剩 11px 可见），
  599 |         // 标签两行时余量也只剩 1px ⇒ 判据是"这行整个在卡内"，不是"大概看得见"。
  600 |         // `expect_grow` 逐档写死（20261001 实测）：下限降到 470 之后，**只有最空的卡**
  601 |         // （短标题 + 无标签，自然高 445）停在下限，3 行标题起就都自然长高了
  602 |         // （510 无标签 / 574 两行标签 / 606 三行标签）⇒ "长高机制真的在长"由后两档证明。
  603 |         for (const [title, n, expectGrow] of [
  604 |           ["面试复盘", 0, false],
  605 |           [LONG_TITLE, 8, true],
  606 |           [LONG_TITLE, 12, true],
  607 |         ] as const) {
  608 |           const r = await paint(page, mk({ tagsN: n, title }));
  609 |           if (expectGrow) {
  610 |             expect.soft(
  611 |               r.card.h > 470,
  612 |               `${n} 个标签（${r.tagRows} 行）：内容超出下限 ⇒ 卡片长高到 470 以上 → card h=${r.card.h} / 标签行数 ${r.tagRows}`,
  613 |             ).toBe(true);
  614 |           } else {
  615 |             expect.soft(
  616 |               Math.abs(r.card.h - 470) < 1,
  617 |               `最空的卡（短标题 + ${n} 个标签）：内容塞得下 ⇒ 停在下限 470 → card h=${r.card.h} / 标签行数 ${r.tagRows}`,
  618 |             ).toBe(true);
  619 |           }
  620 |           expect.soft(
  621 |             r.cardOverflow <= 1,
  622 |             `卡片不溢出（overflow: hidden 没在裁东西） → 溢出 ${r.cardOverflow}px`,
  623 |           ).toBe(true);
  624 |           expect.soft(
  625 |             !!r.upd && r.upd.bottom <= r.card.bottom,
  626 |             `「更新于」整行在卡内（底 ≤ 卡底） → upd.bottom ${r.upd ? r.upd.bottom : "—"} / card.bottom ${r.card.bottom}`,
  627 |           ).toBe(true);
  628 |           expect.soft(
  629 |             r.footer.bottom <= r.card.bottom,
  630 |             `页脚整行在卡内（作者署名没跑出去） → footer.bottom ${r.footer.bottom} / card.bottom ${r.card.bottom}`,
  631 |           ).toBe(true);
  632 |         }
  633 |         // 反面对照：标签只有一行时**也不许**停在 470 —— 长高不能变成"每张卡都松垮"，但下限
  634 |         // 降了之后这一档本来就该按内容高（3 行标题 + 1 行标签 = 542）。
  635 |         const flat = await paint(page, mk({ tagsN: 3 }));
  636 |         expect.soft(
  637 |           Math.abs(flat.card.h - 542) < 1,
  638 |           `3 个标签（1 行）+ 3 行标题：按内容高 542px（不是被下限硬撑出来的数） → card h=${flat.card.h}` +
  639 |             `（本机无中文字体，Python 原版同红 547，环境差异）`,
> 640 |         ).toBe(true);
      |           ^ Error: 3 个标签（1 行）+ 3 行标题：按内容高 542px（不是被下限硬撑出来的数） → card h=547（本机无中文字体，Python 原版同红 547，环境差异）
  641 |         expect.soft(
  642 |           !!flat.upd && flat.upd.bottom <= flat.card.bottom,
  643 |           `该档「更新于」也在卡内 → upd.bottom ${flat.upd ? flat.upd.bottom : "—"} / card.bottom ${flat.card.bottom}`,
  644 |         ).toBe(true);
  645 | 
  646 |         expect.soft(
  647 |           errs().length === 0,
  648 |           `无 JS 运行时报错 → ${errs().slice(0, 2).join("; ")}`,
  649 |         ).toBe(true);
  650 |       },
  651 |     );
  652 |   });
  653 | });
  654 | 
```