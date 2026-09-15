import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** 展品注册表。加一件展品 = 加一项 + 加一个组件，不建插件系统、不做切换 UI
 *  （v1 只放一件，壳硬编码取 [0]；等真有两件以上再谈切换）。 */
export interface Exhibit {
    key: string;
    title: string;
    /** 角标，如「新」 */
    badge?: string;
    /** 标题栏右侧的一句话操作提示 */
    hint?: string;
    /** 必须 lazy：展品代码只在夜间挂载时才下载 */
    Component: LazyExoticComponent<ComponentType>;
}

export const EXHIBITS: Exhibit[] = [
    {
        key: 'wordgraph',
        title: '文章向量空间',
        badge: '新',
        hint: '拖动旋转 · 滚轮缩放 · 双击词跳文章',
        Component: lazy(() => import('./wordgraph/WordGraphExhibit')),
    },
];
