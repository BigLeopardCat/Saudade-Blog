import {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {Link} from 'react-router-dom';
import {t, useLocale} from '../../i18n';
import {useAuthToken} from '../../utils/useAuthToken';
import {Desk} from '../../pages/Support';
import './support-mode.css';

export default function SupportMode() {
    useLocale();
    const token = useAuthToken();
    const [panel, setPanel] = useState<HTMLElement>();
    const [open, setOpen] = useState(false);
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        let attributes: MutationObserver | undefined;
        const findPanel = () => {
            const widget = document.querySelector<HTMLElement>('#waifu-chat');
            if (!widget?.querySelector('[data-chat-host-action]') || !widget.querySelector('[data-chat-host-panel]')) return;
            setPanel(widget);
            const update = () => setVisible(widget.classList.contains('active') &&
                !['collapsed', 'docked'].includes(widget.dataset.windowMode ?? ''));
            update();
            attributes = new MutationObserver(update);
            attributes.observe(widget, {attributes: true, attributeFilter: ['class', 'data-window-mode']});
            observer.disconnect();
        };
        const observer = new MutationObserver(findPanel);
        observer.observe(document.body, {childList: true, subtree: true});
        findPanel();
        return () => {observer.disconnect(); attributes?.disconnect();};
    }, []);
    useEffect(() => {
        if (!panel || !open) return;
        panel.dataset.supportMode = 'true';
        const close = () => setOpen(false);
        const closeOnEsc = (event: KeyboardEvent) => {
            const focused = document.activeElement;
            if (event.key === 'Escape' && visible && (focused === document.body || panel.contains(focused))) {
                event.stopPropagation();
                close();
                panel?.querySelector<HTMLButtonElement>('[data-chat-host-action] button')?.focus();
            }
        };
        const button = panel.querySelector('#chat-close');
        button?.addEventListener('click', close);
        document.addEventListener('keydown', closeOnEsc, true);
        if (visible) panel.querySelector<HTMLElement>('#lingyue-support-mode')?.focus({preventScroll: true});
        return () => {
            delete panel.dataset.supportMode;
            button?.removeEventListener('click', close);
            document.removeEventListener('keydown', closeOnEsc, true);
        };
    }, [open, panel, visible]);
    if (!panel) return null;
    const rail = panel.querySelector('[data-chat-host-action]');
    const outlet = panel.querySelector('[data-chat-host-panel]');
    if (!rail || !outlet) return null;
    const label = t(open ? '返回对话' : '问题反馈');
    return <>
        {createPortal(<button type="button" className="chat-rail-btn" title={label} aria-label={label}
            aria-controls="lingyue-support-mode" aria-expanded={open} onClick={() => setOpen(value => !value)}>
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d={open ? 'M14 6l-6 6 6 6' : 'M20 5H4v12h4v4l5-4h7V5zM12 8v4m0 2v1'}/>
            </svg>
        </button>, rail)}
        {open && visible && createPortal(<section id="lingyue-support-mode" tabIndex={-1} aria-label={t('泠月喵客服')}>
            <header><strong>{t('泠月喵客服')}</strong><Link to="/support">{t('客服中心')}</Link></header>
            <p className="support-status">{t('需要时由站点客服接手，请勿发送密码或验证码。')}</p>
            {token ? <Desk key={token} token={token} staff={false} compact/> :
                <p><Link to="/login?returnTo=support">{t('请先登录')}</Link></p>}
        </section>, outlet)}
    </>;
}
