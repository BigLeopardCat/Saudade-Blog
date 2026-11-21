import {t as tr, useLocale} from '../../../i18n';
import './index.sass'
import React from 'react';
import SocialIcon from './SocialIcon';
import {message} from 'antd';

interface SocialButtonProps { SocialName: string; url?: string; copyText?: string }
const labels = {QQ: 'QQ', Github: 'GitHub', Bilibili: '哔哩哔哩', Email: '邮箱'};
const SocialButton: React.FC<SocialButtonProps> = ({SocialName, url, copyText}) => {
    useLocale();
    const label = labels[SocialName as keyof typeof labels];
    if (!label) return null;
    const handleCopy = async (event: React.MouseEvent) => {
        event.preventDefault();
        if (!copyText) return;
        let copied = false;
        try { await navigator.clipboard.writeText(copyText); copied = true; } catch {
            const previous = document.activeElement as HTMLElement | null;
            const textarea = document.createElement('textarea');
            textarea.value = copyText;
            textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
            document.body.appendChild(textarea);
            textarea.select();
            try { copied = document.execCommand('copy'); } catch { /* Report failure below. */ }
            textarea.remove();
            previous?.focus({preventScroll: true});
        }
        if (copied) message.success(tr("{0} 已复制到剪贴板", {"0": label}));
        else message.error(tr("复制失败，请检查浏览器剪贴板权限"));
    };
    const content = <><span className="svgContainer"><SocialIcon name={SocialName}/></span><span>{label}</span></>;
    const className = `SocialBtn social-${SocialName.toLowerCase()}`;
    return copyText
        ? <button type="button" className={className} aria-label={tr("复制 {0}", {"0": SocialName})} title={tr("复制{0}", {"0": label})} onClick={handleCopy}>{content}</button>
        : <a className={className} href={url} target="_blank" rel="noopener noreferrer" aria-label={label}>{content}</a>;
};
export default SocialButton;
