import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  htmlDoc,
  withSandbox,
  collectPageErrors,
} from "./sandbox";

/**
 * 文章网格：一格一张卡、卡必须填满那一格（原 tests/article-grid.test.py，20261019 迁移）。
 *
 * 根因是量出来的，不是看出来的（真 index.sass + 真 Chromium，逐档扫 375→2560）：
 * `.allArticles` 是 repeat(auto-fit, minmax(340px, 1fr)) 的网格，网格项 `.article`
 * 是 display: flex —— 但那条 flex 只为纵轴而写，横轴上谁也没说话。于是卡
 * （`.ArticleCard`，`.article` 的 flex 子项）按 flex-basis: auto 取内容宽度：
 * 内容比格子宽的卡被压回格子宽，内容短的卡就停在原地 ⇒ 同一排里窄一截。
 *
 * 判据四组：① 同排等宽；② 卡宽等于网格轨道宽（是"填满格子"而不是"碰巧都窄"）；
 * ③ 同行等高（纵轴老契约）；④ 负空间——把 `flex: 1 1 auto` 换回初始值 `0 1 auto`，
 * 缺陷必须重现（不然判据咬不住缺陷）。
 */
const SASS_FILE = path.join(
  FE_DIR,
  "src/frontHome/Content/ContentHome/index.sass",
);
const RESET_CSS = readFileSync(path.join(FE_DIR, "src/frontHome/main.css"), "utf-8");

// 内容形状 = 线上六篇真实的标题与简介（缺陷触发条件是"卡的自然宽度 < 格子宽"，
// 自然宽度由标题与简介共同决定；线上那两篇「六字标题 + 简介只有一个空格」正是窄卡）。
const SHAPES: Array<[string, string, number]> = [
  ["我，管理员！", " ", 0],
  ["文章向量空间图谱项目文档", "本文是首页「向量图谱」展示柜的完整技术记录", 3],
  [
    "Python asyncio 异步并发：进程、线程、协程、任务与事件循环",
    "本文从操作系统到 Python，系统梳理了进程、线程、协程、任务与事件循环的来龙去脉。",
    6,
  ],
  ["IoT 设备接入物联网平台指南", "IoT 设备接入物联网平台指南", 0],
  [
    "Saudade Blog AI Agent（泠月喵）架构文档",
    "面向维护者的全链路技术文档。覆盖看板娘对话系统的每一个环节。",
    10,
  ],
  ["Git从入门到入土", " ", 2],
];

const STATS =
  '<div class="ArticleStats">' +
  '<span class="ArticleStat" title="阅读量"><span class="ArticleStatNum">128</span></span>' +
  '<span class="ArticleStat" title="点赞数"><span class="ArticleStatNum">36</span></span>' +
  '<span class="ArticleStat" title="收藏数"><span class="ArticleStatNum">12</span></span>' +
  "</div>";

// 标签：antd Tag 的实测几何（height 22 / margin 5 / padding 0 7）——沙箱里没有
// antd 的 CSS，按它的尺寸手写（与 article-card-hover 同一份口径）。
function tags(n: number): string {
  return (
    '<div class="tags" style="width:100%;margin-top:10px">' +
    Array.from(
      { length: n },
      (_, i) =>
        `<span style="display:inline-block;height:22px;line-height:22px;margin:5px;` +
        `padding:0 7px;border:1px solid #d9d9d9;border-radius:4px;font-size:12px">标签${i}</span>`,
    ).join("") +
    "</div>"
  );
}

function card(i: number): string {
  const [title, desc, ntags] = SHAPES[i % SHAPES.length];
  // 选择器链一层都不能缺（缺一层整套规则静默失效）。
  return `
  <div class="article" id="art${i}">
    <div class="ArticleCard" id="card${i}">
      <div class="ArticleCover" id="cover${i}"></div>
      <div class="ArticleContent" id="content${i}">
        <div class="ArticleHead"><h4 style="color:#5a8fbf"># 编程随笔</h4>${STATS}</div>
        <h3 class="ArticleTitle">${title}</h3>
        <div class="descSlot"><p class="ArticleDescription">${desc}</p></div>
        <div style="width:100%;margin-top:auto;flex-shrink:0">
          ${tags(ntags)}
          <div class="ArticleFooter" style="display:flex;align-items:center;padding-bottom:20px;margin-top:10px">
            <span style="display:inline-block;width:40px;height:40px;border-radius:50%;background:#ccc;margin-right:10px"></span>
            <span style="font-weight:bold;margin-right:10px;line-height:22px;font-size:14px">林陌青川</span>
            <div style="position:relative;display:flex;flex-direction:column">
              <span style="font-size:12px;color:#7f7e7e;line-height:22px">发布于 2026-09-30</span>
              <span style="position:absolute;top:100%;margin-top:6px;left:0;font-size:12px;color:#7f7e7e;line-height:22px;white-space:nowrap">更新于 2026-09-30</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

const N_CARDS = 12;
// 逐档扫：手机两列、两个媒体块、桌面 2–6 列各台阶。缺陷在每一档都有。
const WIDTHS = [375, 414, 640, 768, 800, 1024, 1280, 1366, 1440, 1680, 1920, 2560];

// 读数：offsetWidth/offsetHeight 不受 CSS transform 影响（卡片有 hover scale）。
const MEASURE = () => {
  const grid = document.querySelector(".allArticles");
  const tracks = getComputedStyle(grid!)
    .gridTemplateColumns.split(" ")
    .map(parseFloat)
    .filter((w) => w > 0.5);
  return {
    tracks,
    cards: [...document.querySelectorAll(".ArticleCard")].map((c) => ({
      w: (c as HTMLElement).offsetWidth,
      h: (c as HTMLElement).offsetHeight,
      top: Math.round(c.getBoundingClientRect().top),
    })),
  };
};

interface CardBox {
  w: number;
  h: number;
  top: number;
}
interface Measure {
  tracks: number[];
  cards: CardBox[];
}

/** 按视口内的 top 归并成"排"（浮点像素差一两 px，按 4px 容差吸附）。 */
function rowsOf(cards: CardBox[]): CardBox[][] {
  const rows: CardBox[][] = [];
  for (const c of [...cards].sort((a, b) => a.top - b.top || a.w - b.w)) {
    const row = rows.find((r) => Math.abs(r[0].top - c.top) <= 4);
    if (row) row.push(c);
    else rows.push([c]);
  }
  return rows;
}

test.describe("文章网格", () => {
  test.setTimeout(180_000);

  test("12 档视口：同排卡片等宽、等于轨道宽、同行等高", async ({ page }) => {
    const css = compileSass(SASS_FILE);
    await withSandbox(
      {
        "index.html": htmlDoc(
          `<div class="ContentContainer"><div class="allArticles">${Array.from(
            { length: N_CARDS },
            (_, i) => card(i),
          ).join("")}</div></div>`,
          RESET_CSS,
          css,
        ),
      },
      async (sb) => {
        const errs = collectPageErrors(page);
        await page.goto(sb.url);
        await page.waitForTimeout(300);

        for (const w of WIDTHS) {
          await page.setViewportSize({ width: w, height: 900 });
          await page.waitForTimeout(120);
          const m = (await page.evaluate(MEASURE)) as Measure;
          const rows = rowsOf(m.cards);
          const track = Math.max(...(m.tracks.length ? m.tracks : [0]));

          const widthsByRow = rows.map((r) => [...new Set(r.map((c) => c.w))].sort((a, b) => a - b));
          test.info().annotations.push({ type: `viewport-${w}`, description: JSON.stringify(widthsByRow) });
          // ① 同排等宽（修复前 1280 屏同一排出现过 265/344/364 三种）
          expect(
            widthsByRow.every((ws) => ws.length === 1),
            `${w}px 各排宽度集合 → ${JSON.stringify(widthsByRow)}`,
          ).toBe(true);
          // ② 卡宽 = 网格轨道宽（±1px）——只判"同排等宽"防不住"整排一起窄"
          const off = rows.flatMap((r) =>
            r.filter((c) => Math.abs(c.w - track) > 1).map((c) => `${w}px 卡${c.w} vs 轨道${track.toFixed(1)}`),
          );
          expect(off.join("; "), `${w}px`).toBe("");
          // ③ 同行等高（`.article` 的 flex 拉伸仍在）
          const heightsByRow = rows.map((r) => [...new Set(r.map((c) => c.h))]);
          expect(
            heightsByRow.every((hs) => hs.length === 1),
            `${w}px 各排高度集合 → ${JSON.stringify(heightsByRow)}`,
          ).toBe(true);
        }

        // ④ 负空间：换回 flex 初始值，缺陷必须在 ≥640px 的每一档重现
        await page.addStyleTag({
          content: ".allArticles > .article > .ArticleCard { flex: 0 1 auto !important }",
        });
        const revived: number[] = [];
        for (const w of WIDTHS) {
          await page.setViewportSize({ width: w, height: 900 });
          await page.waitForTimeout(120);
          const m = (await page.evaluate(MEASURE)) as Measure;
          if (rowsOf(m.cards).some((r) => new Set(r.map((c) => c.w)).size > 1)) revived.push(w);
        }
        const desktop = WIDTHS.filter((w) => w >= 640);
        expect(
          desktop.filter((w) => !revived.includes(w)),
          `重现档位 ${revived}；缺 ${desktop.filter((w) => !revived.includes(w))}`,
        ).toEqual([]);

        // 对照：摘掉覆盖后同排又齐回来
        await page.evaluate(() => {
          const styles = document.querySelectorAll("style");
          styles[styles.length - 1]?.remove();
        });
        await page.waitForTimeout(150);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.waitForTimeout(150);
        const m = (await page.evaluate(MEASURE)) as Measure;
        expect(
          rowsOf(m.cards).every((r) => new Set(r.map((c) => c.w)).size === 1),
          "摘掉覆盖后",
        ).toBe(true);

        expect(errs(), "全程无页面异常").toEqual([]);
      },
    );
  });
});
