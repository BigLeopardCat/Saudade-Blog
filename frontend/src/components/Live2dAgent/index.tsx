import { useEffect, useRef } from 'react';
// 注册 window.__chatRenderMarkdown / __chatHighlight，供看板娘对话框复用博客同款 markdown 渲染
import '../../utils/chatMarkdown';

/**
 * 使用 live2d-widgets autoload 方式加载看板娘
 * 通过 script 标签直接加载 autoload.js
 */
const Live2dAgent: React.FC = () => {
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    // 注入 autoload 脚本，让 live2d-widgets 自己管理一切
    const s = document.createElement('script');
    s.src = '/live2d-widgets/autoload.js?v=20260819b';
    s.async = true;
    document.head.appendChild(s);

    return () => {
      // cleanup not possible with script approach
    };
  }, []);

  return null;
};

Live2dAgent.displayName = 'Live2dAgent';
export default Live2dAgent;
