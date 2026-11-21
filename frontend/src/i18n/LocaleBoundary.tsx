import {ConfigProvider} from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import {useEffect, type ReactNode} from 'react';
import {useLocale} from './index';

export default function LocaleBoundary({children}: {children: ReactNode}) {
    const locale = useLocale();
    useEffect(() => {
        document.documentElement.lang = locale;
        dayjs.locale(locale === 'en' ? 'en' : 'zh-cn');
    }, [locale]);
    return <ConfigProvider locale={locale === 'en' ? enUS : zhCN}>{children}</ConfigProvider>;
}
