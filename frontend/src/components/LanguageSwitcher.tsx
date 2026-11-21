import {setLocale, t, useLocale} from '../i18n';
import './language-switcher.css';

export default function LanguageSwitcher({standalone = false}: {standalone?: boolean}) {
    const locale = useLocale();
    const next = locale === 'en' ? 'zh-CN' : 'en';
    return <button type="button" className={`sceneTool languageSwitcher${standalone ? ' languageSwitcherStandalone' : ''}`}
        lang={next} aria-label={locale === 'en' ? '切换为中文' : 'Switch to English'}
        title={t('切换界面语言')} data-testid="language-switch"
        onClick={() => setLocale(next)}>{locale === 'en' ? '中文' : 'EN'}</button>;
}
