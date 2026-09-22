import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { loadManifest } from './wordgraph/loader';

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

export const EXHIBITS: Exhibit[] = [
    {
        key: 'wordgraph',
        title: '文章向量空间',
        // 角标 = 向量库的**更新时间**（不再写「新」——用户 20260916 拍板：只显示时间，
        // 不带"向量库"前缀，完整语义放 title 提示）。时间取产物 manifest 的 built，
        // 由建图脚本写入 ⇒ 刷新页面就能看到"这批词是什么时候算出来的"。
        badge: async () => {
            const m = await loadManifest();
            return m?.built ? fmtBuilt(m.built) : null;
        },
        // 提示词跟着"默认锁定"改了：窗口锁定时滚轮是穿透给页面的（见 engine.setLocked），
        // 原来那句"滚轮穿行"会让用户以为滚不动是坏了。重要的话放句首，窄窗口省略号截尾。
        hint: '默认锁定（滚轮正常翻页）· 点解锁后：拖动旋转 / 滚轮穿云 / 双击跳文章',
        Component: lazy(() => import('./wordgraph/WordGraphExhibit')),
    },
];

/** `2026-09-16T01:31:59+08:00` → `2026年09月16日 UTC+8 01:31:59`。
 *  形状不符就原样返回——好消息是一条能看懂的时间串，坏消息也好过空白。 */
function fmtBuilt(s: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(s);
    if (!m) return s;
    return `${m[1]}年${m[2]}月${m[3]}日 UTC+8 ${m[4]}`;
}
