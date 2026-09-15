import { Suspense } from 'react';
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
            <header className="vit-bar">
                <span className="vit-title">{ex.title}</span>
                {ex.badge && <em className="vit-badge">{ex.badge}</em>}
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
