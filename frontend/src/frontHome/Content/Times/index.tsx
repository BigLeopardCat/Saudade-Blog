import {t as tr, useLocale} from '../../../i18n';
import './index.sass'
import { useEffect, useState } from "react";
import {Button, Timeline} from 'antd';
import dayjs from "dayjs";
import { motion } from 'framer-motion';
import scrollToTop from "../../../utils/scrollToTop.tsx";
import {useArchiveFeedInfiniteQuery} from "../../../store/publicContentApi";
import {Link} from "react-router-dom";
import SeoHelmet from "../../../components/SeoHelmet";
const Times = () => {
    useLocale();
    const {data, isLoading, isFetching, isError, isFetchNextPageError,
        hasNextPage, fetchNextPage, refetch} = useArchiveFeedInfiniteQuery();
    const rows = data?.pages.flatMap(page => page.items) ?? [];
    const total = data?.pages[0]?.total;
    const [todayInfo, setTodayInfo] = useState({
        year: '',
        dayOfYear: 0,
        yearPercentage: 0,
        dayPercentage: 0
    });

    useEffect(() => {
        scrollToTop();
        const updateTodayInfo = () => {
            const now = new Date();
            const start = new Date(now.getFullYear(), 0, 0);
            const diff = now.getTime() - start.getTime();
            const oneDay = 1000 * 60 * 60 * 24;
            const dayOfYear = Math.floor(diff / oneDay);

            const totalDays = (now.getFullYear() % 4 === 0 && now.getFullYear() % 100 !== 0) || now.getFullYear() % 400 === 0 ? 366 : 365;
            const yearPercentage = (dayOfYear / totalDays) * 100;
            let dayPercentage = ((now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400) * 100;

            dayPercentage = parseFloat(dayPercentage.toFixed(6));

            setTodayInfo({
                year: now.getFullYear().toString(),
                dayOfYear: dayOfYear,
                yearPercentage: parseFloat(yearPercentage.toFixed(6)),
                dayPercentage: dayPercentage
            });
        };

        updateTodayInfo();

        const intervalId = setInterval(updateTodayInfo, 1000);

        return () => clearInterval(intervalId);
    }, []);

    return <div className='TimesContainer'>
            <SeoHelmet title={tr("归档")} url="/times" />
            <div className="timePass">
                <h2>{tr("归档")}</h2>
                <h3>{total === undefined ? (isError ? tr("文章数量暂不可用") : tr("正在读取文章数量…")) : tr("共有 {0} 篇文章，再接再厉", {"0": total})}</h3>
                <hr></hr>

                <motion.div
                    className='Pass'
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    transition={{ type: "spring", stiffness: 260, damping: 20 }}
                >
                <div className='Pass'>
                    <p>{tr("今天是 {year} 年的第 {day} 天", {year: todayInfo.year, day: todayInfo.dayOfYear})}</p>
                    <p>{tr("今年已过")} {todayInfo.yearPercentage}%</p>
                    <p>{tr("今天已过")} {todayInfo.dayPercentage}%</p>
                    <p>{tr("活在当下，珍惜眼下")}</p>
                </div></motion.div>
            </div>

                <Timeline
                    items={rows.map(item => ({
                        key: item.noteKey,
                        children: <Link className='Link archiveEntry' to={`/article/${item.noteKey}`}>
                            {item.noteTitle}<span>{dayjs(item.createTime).format('YYYY-MM-DD')}</span>
                        </Link>
                    }))}
                    className='timeLine'
                />
                <div className='archiveStatus' aria-live='polite'>
                    {isLoading && <span role='status'>{tr("正在加载归档…")}</span>}
                    {isError && <div role='alert'>{tr("归档没能读取出来")}<Button onClick={() => isFetchNextPageError ? fetchNextPage() : refetch()}
                                loading={isFetching}>{tr("重试")}</Button>
                    </div>}
                    {!isLoading && !isError && rows.length === 0 && <span>{tr("还没有公开文章")}</span>}
                    {hasNextPage && !isError && <Button onClick={() => fetchNextPage()}
                        loading={isFetching}>{tr("加载更多归档")}</Button>}
                </div>
    </div>;
}

export default Times;
