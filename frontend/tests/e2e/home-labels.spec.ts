import { test, expect } from "@playwright/test";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  htmlDoc,
  withSandbox,
  collectPageErrors,
} from "./sandbox";

/**
 * 首页三块标签（置顶 / 文章 / More）的解剖学验收：真 sass + 真类名 + 量计算的样式
 * （原 tests/home-labels.test.py，20261019 迁移）。
 *
 * 20261001 八轮（用户第 4 条：「那三个标签丑死了，大改，其中置顶的标签还可以，但是动效
 * 上下晃动给人不稳定失去掌控的心理感觉」）把这三块又重排了一次。它们**全是纯 CSS 的形状
 * 与动效**，没有一处能用"源码里有没有这段字符串"证明对了：
 *
 *   · 置顶的尾尖是 `clip-path` 切出来的 —— 源码写着 `polygon(...)` 不代表浏览器算出来的
 *     就是一枚箭头尾尖（写成四角手撕边也是合法的 `polygon`）；
 *   · 「文章」左缘那道装订边（`border-left`）与右端的圆角，是**实测盒子**；
 *   · More 那枚 chevron 是"两条边 + 转 +45°"（指向下，20261004 由 -45° 改来），
 *     靠 `::after` 的宽高与 border 判定；
 *   · **三块牌子静置时一律不许动**（八轮的总纲，也是用户这句话的落点）：常驻循环
 *     （`ribbon-float` / `tag-twinkle` / `more-nudge`）撤得只剩置顶尾尖那枚 ✦ 的呼吸，
 *     且它只动 opacity、不产生位移。这条判据是 `animationName` + `transform` 一起读的
 *     —— "不动"不是一个能在源码里 grep 到的事实，得问浏览器要计算后的值；
 *   · **减少动效档下 ✦ 必须还在**（六轮那里是 `opacity: 0`——当时 `::after` 是高光，
 *     藏着对；七轮换成了 ✦，藏掉就等于把记号删了）。这一条只有真跑 reduce 档才看得见。
 *
 * 本机无中文字体（汉字渲染成 .notdef 方块），所以断言全走**盒子与计算值**，不比字形；
 * 箭头/星号这类非汉字符号不受影响。
 */

const SASS_FILE = path.join(
  FE_DIR,
  "src/frontHome/Content/ContentHome/index.sass",
);

interface PseudoBefore {
  content: string;
  w: string;
  h: string;
  bg: string;
  pos: string;
}
interface PseudoAfter {
  content: string;
  w: string;
  h: string;
  opacity: string;
  anim: string;
  borderRight: string;
  borderBottom: string;
  transform: string;
  pos: string;
}
interface Probe {
  w: number;
  h: number;
  clip: string;
  anim: string;
  transform: string;
  radius: string;
  borderLeftW: string;
  borderLeftColor: string;
  borderTopColor: string;
  before: PseudoBefore;
  after: PseudoAfter;
}

test.describe("首页三块标签", () => {
  test.setTimeout(180_000);

  test("置顶缎带 / 文章和纸条 / More chevron：形状、静置与减少动效档", async ({
    page,
  }) => {
    const css = compileSass(SASS_FILE);
    // 这三块标签住在 `.ContentContainer` 里（`.allContent` / `.more` 都挂在它下面）——
    // 沙箱必须补上这层祖先，否则选择器一条都不命中，量到的全是浏览器默认值。
    await withSandbox(
      {
        "index.html": htmlDoc(
          '<div class="ContentContainer">' +
            '<div class="TopArticle" style="position:relative;width:520px;height:280px;background:#fff">' +
            '<div class="Top"><span class="TopTape" id="tape">' +
            '<i class="iconfont icon-sticky1" id="tapeIcon" aria-hidden="true"></i>置顶</span></div>' +
            "</div>" +
            '<div class="allContent" id="plate">' +
            '<i class="iconfont icon-wenzhang2" id="plateIcon" aria-hidden="true"></i>文章</div>' +
            '<div class="allContent more" id="more">More</div>' +
            "</div>",
          "body{margin:0;font-family:sans-serif}",
          css,
        ),
      },
      async (sb) => {
        const errs = collectPageErrors(page);
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(sb.url);
        await page.waitForTimeout(400);

        // 量一个伪元素的盒子。`getComputedStyle(el, '::after')` 拿的是**计算后的声明**，
        // 不是布局盒子 —— 宽高要按 pseudo 的 width/height 读（这三块都给了显式值，
        // 没有 auto 的情形，所以够用）。
        const probe = (sel: string): Promise<Probe> =>
          page.evaluate((s: string) => {
            const el = document.querySelector(s)!;
            const b = getComputedStyle(el, "::before");
            const a = getComputedStyle(el, "::after");
            return {
              w: el.getBoundingClientRect().width,
              h: el.getBoundingClientRect().height,
              clip: getComputedStyle(el).clipPath,
              anim: getComputedStyle(el).animationName,
              // 八轮的判据要读它：撤掉常驻动画之后，斜贴的角度**改由基规则的 transform 给**
              // ——"有没有角度"只有计算值知道（源码里写了 `rotate(-3.6deg)` 也可能是被
              // 另一条同特异度的规则压掉的）。
              transform: getComputedStyle(el).transform,
              radius: getComputedStyle(el).borderRadius,
              // 「文章」牌子的装订边（第八轮由 `::before` 渐变竖脊改成 `border-left` 平涂）
              borderLeftW: getComputedStyle(el).borderLeftWidth,
              borderLeftColor: getComputedStyle(el).borderLeftColor,
              borderTopColor: getComputedStyle(el).borderTopColor,
              before: {
                content: b.content,
                w: b.width,
                h: b.height,
                bg: b.backgroundImage,
                pos: b.position,
              },
              after: {
                content: a.content,
                w: a.width,
                h: a.height,
                opacity: a.opacity,
                anim: a.animationName,
                borderRight: a.borderRightWidth,
                borderBottom: a.borderBottomWidth,
                transform: a.transform,
                pos: a.position,
              },
            };
          }, sel);

        // ── 【一】置顶：漫画缎带（右端尾尖） ──
        const tape = await probe("#tape");
        // 尾尖的判据 = 顶点里有一个 **100% 50%**（右缘正中收成一点）+ 共 5 个顶点。
        // 六轮那版是 8 个顶点的四角手撕边，两种写法都"是 polygon"，只有顶点表分得开。
        const clip = tape.clip.replace(/ /g, "");
        expect(
          (clip.match(/,/g) ?? []).length === 4 && clip.includes("100%50%"),
          `轮廓是 5 顶点缎带（右端 \`100% 50%\` 尾尖） → ${tape.clip}`,
        ).toBe(true);
        // 左端两个顶点必须**同为 0**（上下各一，中间不开豁口）——「直边」= x 一路是 0。
        // ⚠️ 别按源码里写的字面去比：`0` 到这一步已经算成 `0px`，源码那串 `0 100%`
        // 在 computedStyle 里是 `0px100%`（本套件初版就栽在这个字面差上）。
        expect(
          clip.startsWith("polygon(0px0px,") && clip.endsWith("0px100%)"),
          `左端是直边（\`0 0\` 起、\`0 100%\` 收 —— 那一头贴在卡片上） → ${tape.clip.slice(0, 60)}`,
        ).toBe(true);
        expect(
          tape.after.content.includes("✦") && tape.after.anim === "tag-twinkle",
          `纸上那枚 ✦ 在尾尖后（\`::after\` 的 content 是 ✦、有呼吸动画） → ${tape.after.content} / ${tape.after.anim}`,
        ).toBe(true);
        // 八轮的第 4 条：**缎带自己不许再动** —— 原话「动效上下晃动给人不稳定失去掌控的
        // 心理感觉」。判据分两半，缺一不可：
        //   ① `animationName` 没有常驻动画（`ribbon-float` 已撤）；
        //   ② 斜贴的角度仍在 —— 它现在由基规则的 `transform` 给。只撤动画不补角度的话
        //      缎带会变成正着贴的，那是另一个形状了（这条正是"撤得对不对"的关键）。
        expect(
          tape.anim === "none",
          `★ 缎带自己不再有常驻动画（\`ribbon-float\` 的慢浮已撤） → ${tape.anim}`,
        ).toBe(true);
        // ⚠️ 浏览器把 `rotate(-3.6deg)` 算成 matrix，从计算值里读不出"是不是 -3.6°"，
        // 所以这条只判"有没有角度"，并紧跟着用**负空间**证明它确实测得到东西。
        expect(
          tape.transform !== "none",
          `★ 斜贴的角度改由基规则的 transform 给（撤了动画也不是正着贴的） → ${tape.transform}`,
        ).toBe(true);
        await page.addStyleTag({
          content:
            ".ContentContainer .TopArticle .Top .TopTape{transform:none!important}",
        });
        await page.waitForTimeout(120);
        expect(
          (await probe("#tape")).transform === "none",
          `（对照）抹掉角度后 transform 真的是 none ⇒ 上一条判据有牙 → ${(await probe("#tape")).transform}`,
        ).toBe(true);
        await page.evaluate(() => {
          const styles = document.querySelectorAll("style");
          styles[styles.length - 1]?.remove();
        });
        await page.waitForTimeout(120);
        expect(
          (await probe("#tape")).transform !== "none",
          "（对照）样式表摘掉后角度回来了",
        ).toBe(true);
        // 六轮的"斜掠高光"必须真的没了：它是 `::after` 上一条 22px 宽的白色渐变
        expect(
          tape.after.w !== "22px" || !String(tape.after.pos).includes("gradient"),
          `六轮那条斜掠高光已撤（\`::after\` 不再是 22px 的白色渐变块） → ${tape.after.w} / ${tape.after.pos}`,
        ).toBe(true);
        expect(
          tape.h >= 20 && tape.h <= 34,
          `高度仍由内容撑开（缎带不该被钉死成一张固定尺寸的片） → ${tape.w.toFixed(1)}×${tape.h.toFixed(1)}`,
        ).toBe(true);

        // ── 【二】「文章」段落签（八轮大改：一张和纸条） ──
        const plate = await probe("#plate");
        // 装订边：八轮从 `::before`（5px 渐变竖脊）改成 `border-left`（4px 平涂）。
        // 判据同时看**宽度**与**颜色**：只看宽度的话，四边都是 1px 也可能碰巧是 4px；
        // 看颜色才能证明"左缘那一道与其余三边不是同一条线"。
        expect(
          plate.borderLeftW === "4px" && plate.borderLeftColor !== plate.borderTopColor,
          `左缘那道装订边在（\`border-left\` 4px、颜色与其余三边不同） → ${plate.borderLeftW} ${plate.borderLeftColor} vs ${plate.borderTopColor}`,
        ).toBe(true);
        expect(
          plate.before.content === "none" || plate.before.content === "",
          `旧的 \`::before\` 渐变竖脊已撤（不再有那条伪元素） → ${plate.before.content}`,
        ).toBe(true);
        // 左直右圆 = 贴纸那头 / 翘起那头（与置顶缎带的直边同款语言）
        expect(
          ["0px10px10px0px", "0px10px10px0"].includes(plate.radius.replace(/ /g, "")),
          `左端直角、右端圆角（\`0 10px 10px 0\`） → ${plate.radius}`,
        ).toBe(true);
        // ★ 母题归置顶独占：这块牌子上**不许**再出现 ✦（原来的撞车正是"丑"的一部分）
        expect(
          !plate.after.content.includes("✦"),
          `★ 这块牌子上没有 ✦（右端那枚记号归置顶独占，不再两处撞车） → ${plate.after.content}`,
        ).toBe(true);
        const icon = await page.evaluate(() => {
          const el = document.querySelector("#plateIcon")!;
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            w: r.width,
            h: r.height,
            radius: s.borderRadius,
            color: s.color,
            bg: s.backgroundImage,
            anim: s.animationName,
            fs: s.fontSize,
          };
        });
        // 七轮那个 20×20 的渐变圆盘是"丑"的第二块：徽章比字还重。八轮回到墨色线性。
        expect(
          icon.bg === "none" && ["0px", "0%"].includes(icon.radius),
          `图标不再装盘（没有圆角背景、没有渐变底） → bg=${icon.bg} r=${icon.radius}`,
        ).toBe(true);
        expect(
          parseFloat(icon.fs) >= 14 &&
            !["rgb(255, 255, 255)", "white"].includes(icon.color),
          `图标是承色的一枚线性字（不是 11px 的白字压在盘上） → ${icon.fs} ${icon.color}`,
        ).toBe(true);
        expect(
          plate.anim === "none" &&
            plate.after.anim === "none" &&
            icon.anim === "none",
          `★ 牌子静置不动（图标那条 twinkle 也撤了 —— 三块牌子里只剩置顶的 ✦ 会呼吸） → ${plate.anim} / ${plate.after.anim} / ${icon.anim}`,
        ).toBe(true);

        // ── 【三】More：右端一枚 chevron（指向下、静置不动，悬停才走） ──
        const more = await probe("#more");
        // chevron = 一个 8×8 的盒子 + 只画右边和下边 + 转 +45°。
        // 判 border 的**宽度**而不是有没有 border：`.allContent` 的基础规则给整块牌子
        // 留了 1px 的四边边框（`border: 1px solid var(--washi-line)`），
        // 只判"有边框"的话，箭头那两条边和牌子自己的四条边分不开。
        expect(
          more.after.borderRight === "2px" && more.after.borderBottom === "2px",
          `箭头是两条边（右 2px + 下 2px，比牌子自己那 1px 粗） → ${more.after.borderRight}/${more.after.borderBottom}`,
        ).toBe(true);
        // ⚠️ 这一条是八轮最容易做错的地方：原来那个 -45° 是 **keyframe 给的**，动画一撤、
        // 基规则里不补 `transform` 的话，箭头就摊平成一个直角（`border-right` +
        // `border-bottom` 就是个 L，不是箭头）。所以这里判的是**撤掉动画之后它还是斜的**。
        expect(
          more.after.anim === "none" && more.after.transform !== "none",
          `★ 箭头静置时不动、但**仍是斜的**（角度已从 keyframe 搬进基规则） → ${more.after.anim} / ${more.after.transform}`,
        ).toBe(true);
        // 方向（20261004 用户第十报：「刷新卡片是向下展示，按钮箭头向右不合适」）。
        // **只判"斜的"是不够的**——−45° 也是斜的，而它画的正是那枚向右的箭头。
        // 角度只能从计算值的矩阵里读：`matrix(a, b, c, d, e, f)`，CSS 正角 = 顺时针
        // ⇒ `b > 0`（顺时针 45°）才是"右 + 下两条边"读成的 ↓；`b < 0` 就是 →。
        const m = more.after.transform;
        const nums = m.includes("matrix")
          ? m
              .slice(m.indexOf("(") + 1, -1)
              .split(",")
              .map(Number)
          : [];
        expect(
          nums.length === 6 && nums[1] > 0.5 && nums[3] > 0.5,
          `★ 箭头指向**下**（旋转矩阵的 b > 0 = 顺时针；−45° 那枚是向右的） → transform=${m}`,
        ).toBe(true);
        expect(
          !more.after.content.includes("✦"),
          `More 不再挂 \`.allContent\` 那枚 ✦（同一族里两枚记号不许撞车） → ${more.after.content}`,
        ).toBe(true);
        expect(
          more.borderLeftW === "4px" && more.borderLeftColor !== more.borderTopColor,
          `左缘装订边仍在（同一块牌子，只是尺寸与手感不同） → ${more.borderLeftW} ${more.borderLeftColor}`,
        ).toBe(true);
        expect(
          more.anim === "none",
          `牌子本身也没有常驻动画 → ${more.anim}`,
        ).toBe(true);

        // 悬停：箭头往前送一点。八轮撤掉 `more-nudge` 之后没有"动画恒压声明"那层了，
        // 这条 `transform` 直接生效 —— 但仍要实测，因为 `:hover` 的链一旦写错就静默失效。
        await page.hover("#more");
        await page.waitForTimeout(400);
        const hov = await probe("#more");
        expect(
          hov.after.transform !== more.after.transform &&
            hov.after.transform !== "none",
          `悬停后箭头顺着指向下移（动效改为只在指针接触时发生） → ${more.after.transform} → ${hov.after.transform}`,
        ).toBe(true);

        // ── 【四】减少动效档 ──
        // ⚠️ hover 的悬停态**会一直粘着**，除非把指针挪走（或页面重挂）。
        // 上面那一步悬停在 `#more` 上，这里不挪开的话量到的是 `.more:hover::after`
        // ——它的 `animation: none` 会让下面的"箭头停住"**假绿**（初版就是这么骗过去的）。
        await page.mouse.move(0, 0);
        await page.waitForTimeout(200);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.waitForTimeout(300);
        const [redTape, redPlate, redMore] = await Promise.all([
          probe("#tape"),
          probe("#plate"),
          probe("#more"),
        ]);
        // 八轮起三块牌子静置本来就不动，这一档要守的只剩"那条唯一的常驻动效（✦ 的呼吸）
        // 真的被关掉"，以及"关的是动画、不是把记号藏掉"。
        expect(
          redTape.anim === "none" && redTape.after.anim === "none",
          `置顶：✦ 的呼吸停 → ${redTape.anim}/${redTape.after.anim}`,
        ).toBe(true);
        // 这条是七轮**专门改对**的：六轮这里给 `::after` 写了 `opacity: 0`（那会儿它是高光），
        // 七轮 `::after` 换成了 ✦ —— 藏掉就等于把缎带的尾尖记号删了。
        expect(
          parseFloat(redTape.after.opacity!) >= 0.99,
          `★ 减少动效下尾尖那枚 ✦ **还在**（只停动画，不隐藏） → ${redTape.after.opacity}`,
        ).toBe(true);
        expect(
          redPlate.anim === "none" && redPlate.after.anim === "none",
          `文章：整块静止（这一档与常速档应当完全一致） → ${redPlate.anim}/${redPlate.after.anim}`,
        ).toBe(true);
        expect(
          redMore.after.anim === "none" && redMore.after.transform !== "none",
          `More：箭头停住且**仍是斜的**（摊平就是两条正交的边，不是箭头） → ${redMore.after.transform}`,
        ).toBe(true);

        expect(errs(), "全程无页面异常").toEqual([]);

        // 出一张图给人眼看形状（缎带尾尖、竖脊、箭头）。落在 playwright 的
        // outputDir（.artifacts，不进仓库跟踪区）；本机无中文字体，汉字是豆腐块，
        // 这张图看的是**轮廓**不是字。
        await page.screenshot({
          path: test.info().outputPath("home-labels.png"),
          fullPage: true,
        });
      },
    );
  });
});
