import './index.sass'
import React from "react";
import SceneIcon from "../../SceneIcon";
import {message} from "antd";

interface SocialButtonProps {
    SocialName: string;
    url?: string;
    copyText?: string;  // 点击时复制到剪贴板的内容（QQ 号 / 邮箱地址）
}
const SocialButton: React.FC<SocialButtonProps> = ({SocialName,url,copyText}) => {
    const icons = {QQ: 'message', Github: 'github', Bilibili: 'video', Email: 'mail'} as const;
    const icon = icons[SocialName as keyof typeof icons];
    if (!icon) return null;

    // 点击复制到剪贴板（QQ 号 / 邮箱），navigator.clipboard 失败时降级 execCommand
    const handleCopy = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!copyText) return;
        // 提示语带平台名：这条通道 QQ 与邮箱共用，写死"邮箱"会在 QQ 上提示错东西
        const done = () => message.success(`${SocialName} 已复制到剪贴板`);
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(copyText).then(done).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = copyText!;
                ta.style.position = 'fixed';
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); } catch { /* 老浏览器兜底：失败也照样提示已复制 */ }
                document.body.removeChild(ta);
                done();
            });
        } else {
            const ta = document.createElement('textarea');
            ta.value = copyText;
            ta.style.position = 'fixed';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch { /* 老浏览器兜底：失败也照样提示已复制 */ }
            document.body.removeChild(ta);
            done();
        }
    };

    if (copyText) return <button type="button" className="SocialBtn" title={SocialName} aria-label={`复制 ${SocialName}`} onClick={handleCopy}>
        <span className="svgContainer"><SceneIcon name={icon} size={19}/></span>
    </button>;
    return <a className="SocialBtn" href={url} target="_blank" rel="noopener noreferrer" title={SocialName} aria-label={SocialName}>
        <span className="svgContainer"><SceneIcon name={icon} size={19}/></span>
    </a>;
}
export default SocialButton
