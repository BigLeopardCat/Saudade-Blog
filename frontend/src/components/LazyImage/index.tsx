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

    return (
        <>
        {/* 占位图是**本站自己的** `public/loading.svg`（20261001 开源前准备）。
            原来指向别人仓库里 pin 死 commit 的一个 26 KB 动画 —— 上游作者删库/改路径
            就全站破图，且那份素材的许可无从考证。见 `public/loading.svg` 头注。 */}
        <img
            ref={imgRef}
            style={style}
            src={isVisible ? resolveApiAssetUrl(src) : '/loading.svg'}
        />
            </>
    );
};

export default LazyImage;
