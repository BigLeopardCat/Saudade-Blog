import { Suspense, useEffect, useState } from 'react';
import { useIsDarkMode } from '../../../../theme';
import { EXHIBITS } from './exhibits';
import './index.sass';

/**
 * 首页展示柜窗口：夜间的容器，未来放公告 / 新特性试验区，本期只装「文章向量空间」。
 *
 * 仅夜间挂载——白天 hero 是整幅视频、中心有人像，这个窗口会抢主视觉。
 * 早退同时也是性能闸：白天连图谱数据都不会去下载（`lazy` + `loadGraph` 都在挂载后才跑）。
 */
export default function Vitrine() {
    const isDark = useIsDarkMode();
    if (!isDark) return null;

    const ex = EXHIBITS[0];
    const Body = ex.Component;

    return (
        <section className="vitrine" aria-label="展示柜">
            {/* 语义化 header 回来了（20260916）：`pages/Dashboard/index.css` 那条裸标签
                规则 `header{position:relative;top:20px}` 已收进 `.shell` 作用域，
                本页的 header 不再被顶下去 20px。改回去之前请先看那条规则还在不在。 */}
            <header className="vit-bar">
                <span className="vit-title">{ex.title}</span>
                <Badge of={ex} />
                {ex.hint && <span className="vit-hint">{ex.hint}</span>}
            </header>
            <div className="vit-body">
                <Suspense fallback={<div className="vit-loading">加载中…</div>}>
                    <Body />
                </Suspense>
            </div>
        </section>
    );
}

/** 角标：文案可能是异步取回的（如产物更新时间戳），读不到就整块不渲染。
 *  独立成组件是为了让 useState/useEffect 无条件调用——Vitrine 在白天会早退，
 *  hook 不能写在早退之后。 */
function Badge({ of }: { of: (typeof EXHIBITS)[number] }) {
    const [text, setText] = useState<string | null>(null);
    useEffect(() => {
        if (!of.badge) return;
        let alive = true;
        Promise.resolve(of.badge()).then((t) => { if (alive) setText(t || null); }).catch(() => { /* 角标是装饰，静默 */ });
        return () => { alive = false; };
    }, [of]);
    if (!text) return null;
    return <em className="vit-badge" title="向量数据库更新时间">{text}</em>;
}
