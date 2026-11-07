import {Card, Statistic} from "antd";
import CountUpDefault from "react-countup";
import { cjsDefault } from "../../utils/cjsDefault";
import './index.sass'
import {useSelector} from "react-redux";
import {adminNotesApi} from "../../apis/adminNotesApi";
import React from "react";
import {useNavigate} from "react-router-dom";
import WordCloud from "../wordCloud";
const CountUp = cjsDefault(CountUpDefault)

const ArticleAnalytics = () => {
    const tagCount = useSelector((state: {tags: any}) => state.tags.tagCount)
    const notes = adminNotesApi.useAdminNoteCountQuery();
    const categoryCount = useSelector((state) => state.categories.categoryCount)
    const navigate = useNavigate();
    const list: {
        index: number
        icon: string
        label: string
        value: number | undefined
        bgColor: string
        bgColorDark: string
        badgeColor: string
        path: string
        isComponent?: boolean
    }[] = [
        {
            index: 1,
            icon: '✨️',
            label: '文章总数',
            value: notes.data,
            bgColor: '#f1dfba',
            bgColorDark: 'rgba(241, 223, 186, 0.16)',
            badgeColor: 'rgba(230,240,0,0.3)',
            path: '/dashboard/notes'
        },
        {
            index: 2,
            icon: '❤️️',
            label: '分类总数',
            value: categoryCount,
            bgColor: '#fbcbd5',
            bgColorDark: 'rgba(251, 203, 213, 0.16)',
            badgeColor: 'rgba(255,0,0,0.3)',
            path: '/dashboard/notes/allcategorize'
        },
        {
            index: 3,
            icon: '🎯',
            label: '标签总数',
            value: tagCount,
            bgColor: '#91ccef',
            bgColorDark: 'rgba(145, 204, 239, 0.16)',
            badgeColor: 'rgba(147,154,216,0.3)',
            path: '/dashboard/notes/alltags'
        }
    ]
    const akVars = (item: {bgColor: string, bgColorDark: string, badgeColor: string}) => ({
        "--ak-bg": item.bgColor,
        "--ak-bg-dark": item.bgColorDark,
        "--ak-badge": item.badgeColor,
    } as React.CSSProperties);
    const formatter = (value: React.ReactText): React.ReactNode => (
        <CountUp end={Number(value)} separator="," />
    );

    return <>
        <div className="analyticsCard">
            {list.map(item => (
                <Card
                    className='akCard'
                    key={item.index}
                    style={{...akVars(item), cursor: item.path ? 'pointer' : 'default'}}
                    onClick={() => item.path && navigate(item.path)}
                >
                    {item.isComponent ? (
                        <div style={{width: '100%', height: '100%', overflow: 'hidden'}}>
                            <WordCloud />
                        </div>
                    ) : (
                        <>
                            <span className="akBadge" aria-hidden="true">{item.icon}</span>
                            <div className="akText">
                                <span className="akLabel">{item.label}</span>
                                {item.index === 1 && notes.isError
                                    ? <button type="button" onClick={() => void notes.refetch()}>数量读取失败，重试</button>
                                    : item.value === undefined ? <span role="status">加载中…</span>
                                    : <Statistic value={item.value} formatter={formatter}/>}
                            </div>
                        </>
                    )}
                </Card>
            ))}
        </div>
    </>
}
export default ArticleAnalytics;
