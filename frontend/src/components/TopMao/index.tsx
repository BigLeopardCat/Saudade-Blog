import './index.sass';
import React from 'react';

interface TopMaoProps {
    currentScrollHeight: number;
}

const TopMao: React.FC<TopMaoProps> = ({ currentScrollHeight }) => {
    const BackToTop = () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    };
    // 本组件由 Head 渲染在 <header> 之外（header 的兄弟节点）——必须脱离 sticky header
    // 的合成上下文：实测 transform 动画在 header 内部时每帧迫使 header 图层子树重新栅格化
    // （GPU 30%+），移出后为独立合成层，摆动只动自己的图层（60fps 满帧，见 index.sass 注释）。
    return (
        <div className={`TopMao ${currentScrollHeight > 500 ? 'TopMaoShow' : ''}`} onClick={BackToTop}></div>
    );
};

export default TopMao;
