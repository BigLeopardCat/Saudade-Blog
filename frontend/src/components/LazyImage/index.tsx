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
        <img
            ref={imgRef}
            style={style}
            src={isVisible ? resolveApiAssetUrl(src) : 'https://cdn.jsdelivr.net/gh/LinMoQC/LinmoBlogCDN@d4a74e1de7b957cca9a9e4ca261ad53b1affcc94/loading.svg'}
        />
            </>
    );
};

export default LazyImage;
