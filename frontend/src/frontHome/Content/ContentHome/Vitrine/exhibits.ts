import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { loadManifest, siteMatches } from './wordgraph/loader';

/** 展品注册表。加一件展品 = 加一项 + 加一个组件，不建插件系统、不做切换 UI
 *  （v1 只放一件，壳硬编码取 [0]；等真有两件以上再谈切换）。 */
export interface Exhibit {
    key: string;
    title: string;
    /** 角标文案。可以返回 Promise（要读产物时间戳这类异步数据）；
     *  返回 null/空串 = 不显示角标。读失败不要抛，静默不显示即可。 */
    badge?: () => string | null | Promise<string | null>;
    /** 标题栏右侧的一句话操作提示 */
    hint?: string;
    /** 必须 lazy：展品代码只在夜间挂载时才下载 */
    Component: LazyExoticComponent<ComponentType>;
}

const ALL_EXHIBITS: Exhibit[] = [
    {
        key: 'wordgraph',
        title: '文章向量空间',
        // 角标 = 向量库的**更新时间**（不再写「新」——用户 20260916 拍板：只显示时间，
        // 不带"向量库"前缀，完整语义放 title 提示）。时间取产物 manifest 的 built，
        // 由建图脚本写入 ⇒ 刷新页面就能看到"这批词是什么时候算出来的"。
        badge: async () => {
            const m = await loadManifest();
            // 不是本站的产物不显示"什么时候建的"：那个时间说的是**别人站点**那批文章
            // 的算法时间，挂在这里会被读成"本站的图谱是这天建的"。
            if (!m?.built || !siteMatches(m.site)) return null;
            return fmtBuilt(m.built);
        },
        // 20261002 锁定态删除后重写：原先这句声明"默认锁定（滚轮正常翻页）· 点解锁后…"，
        // 现在没有锁定可解，交互在放大态直接就位（滚轮缩放由引擎 onWheel 接管）。
        // 未放大时卡片整块 `pointer-events: none` ⇒ 页面照常滚动，不必在提示里交代。
        hint: '点开放大后：拖动旋转 / 滚轮穿云 / 双击跳文章',
        Component: lazy(() => import('./wordgraph/WordGraphExhibit')),
    },
];

/** 展品恒注册（20261003）。
 *
 *  这里原来是一道**构建期**的语料归属闸（`__GRAPH_LOCAL__`，见 `vite.config.ts`）：
 *  不是本站就整件不注册，第三方 clone 部署看到的是"首页没有这件展品"。
 *  那道闸的问题是它把"迁移后重建"这条路也一并关死了——判据烧死在 bundle 里，
 *  构建机上看不到新域名的产物，于是**自己重建过图谱的人照样看不到自己的图**。
 *
 *  现在闸在运行期：`loader.siteMatches(manifest.site)` 与浏览器当前 origin 比对，
 *  不符就不取产物、不显示角标（上面那条），展品本身由 `WordGraphExhibit` 渲染成
 *  "尚未为本站点生成，请在后台重建"——**告诉部署者该做什么**，而不是让他以为
 *  这个功能坏了。别人站点的文章向量空间在任何一条路上都不会被画出来。 */
export const EXHIBITS: Exhibit[] = ALL_EXHIBITS;

/** `2026-09-16T01:31:59+08:00` → `2026年09月16日 UTC+8 01:31:59`。
 *  形状不符就原样返回——好消息是一条能看懂的时间串，坏消息也好过空白。 */
function fmtBuilt(s: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(s);
    if (!m) return s;
    return `${m[1]}年${m[2]}月${m[3]}日 UTC+8 ${m[4]}`;
}
