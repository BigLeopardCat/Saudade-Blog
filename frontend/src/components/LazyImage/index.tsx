/**
 * 图片懒加载组件
 */

import React, { useRef, useEffect, useState } from 'react';
import { resolveApiAssetUrl } from '../../utils/runtimeApi';

interface LazyImageProps {
    src: string;
    threshold?: number;
    /** 透传到 img 的行内样式（封面裁剪参数走这里） */
    style?: React.CSSProperties;
}

const LazyImage: React.FC<LazyImageProps> = ({ src, threshold = 0.5, style }) => {
    const imgRef = useRef<HTMLImageElement>(null);
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setIsVisible(true);
                    observer.unobserve(entry.target);
                }
            },
            {
                threshold
            }
        );

        if (imgRef.current) {
            observer.observe(imgRef.current);
        }

        return () => {
            if (imgRef.current) {
                observer.unobserve(imgRef.current);
            }
        };
    }, [imgRef, threshold]);

    // 地址为空 ⇒ **一个元素都不渲染**。`<img src="">` 不会"什么都不做"：空串按当前文档
    // 地址解析，于是每个没封面的条目都朝页面本身再发一次请求，必然失败并画成破图图标
    // ——线上真实访客的 `type=resource_error … msg=img 资源加载失败`（url 就是文章页/
    // 首页本身）撞的正是这一条。没有封面时露出卡片自己的底色，比一个破图图标干净。
    // 注意这条 return 必须在**所有 hook 之后**（上面三个照常执行，ref 为 null 时
    // 观察器那两处本来就有 `if (imgRef.current)` 兜着）。
    const resolved = resolveApiAssetUrl(src);
    if (!resolved) {
        return null;
    }

    return (
        <>
        {/* 占位图是**本站自己的** `public/loading.svg`（20261001 开源前准备）。
            原来指向别人仓库里 pin 死 commit 的一个 26 KB 动画 —— 上游作者删库/改路径
            就全站破图，且那份素材的许可无从考证。见 `public/loading.svg` 头注。 */}
        <img
            ref={imgRef}
            style={style}
            src={isVisible ? resolved : '/loading.svg'}
        />
            </>
    );
};

export default LazyImage;
