import {Card, Statistic} from "antd";
import CountUp from "react-countup";
import './index.sass'
import {useSelector} from "react-redux";
import {noteList} from "../../store/components/note.tsx";
import React from "react";
import {useNavigate} from "react-router-dom";
import WordCloud from "../wordCloud";

const ArticleAnalytics = () => {
    const tagCount = useSelector((state: {tags: any}) => state.tags.tagCount)
    const noteCount = useSelector((state: { notes:noteList  }) => state.notes.noteCount);
    // @ts-ignore
    const categoryCount = useSelector((state) => state.categories.categoryCount)
    const navigate = useNavigate();
    
    // isComponent 目前没有任何一项设为 true（WordCloud 那个分支因此不渲染），
    // 但字段保留在类型里：分支是既有行为，收口类型不等于删功能
    const list: {
        index: number
        name: React.ReactNode
        value: number
        bgColor: string
        bgColorDark: string
        path: string
        isComponent?: boolean
    }[] = [
        {
            index: 1,
            name: <p><span className="logo2" style={{ backgroundColor: 'rgba(230,240,0,0.3)'}}>✨️</span>文章总数</p>,
            value: noteCount,
            bgColor: '#f1dfba',
            bgColorDark: 'rgba(241, 223, 186, 0.16)',
            path: '/dashboard/notes'
        },
        {
            index: 2,
            name: <p><span className="logo2" style={{ backgroundColor: 'rgba(255,0,0,0.3)'}}>❤️️</span>分类总数</p>,
            value: categoryCount,
            bgColor: '#fbcbd5',
            bgColorDark: 'rgba(251, 203, 213, 0.16)',
            path: '/dashboard/notes/allcategorize'
        },
        {
            index: 3,
            name: <p><span className="logo2" style={{ backgroundColor: 'rgb(147,154,216,0.3)'}}>🎯</span>标签总数</p>,
            value: tagCount,
            bgColor: '#91ccef',
            bgColorDark: 'rgba(145, 204, 239, 0.16)',
            path: '/dashboard/notes/alltags'
        }
    ]
    // 卡面颜色改用 CSS 变量传递、由 .akCard 的类规则落地，**不再写进内联 style**：
    // 内联样式特异性最高，颜色一旦写死在那里，`.dark &` 变体就永远赢不了它。
    // 这正是 20260923 后台接上 antd 深色 token 时踩的坑——卡里 Statistic 的文字
    // 转成了白色，白字压在写死的浅色卡面上只有 1.26:1（见
    // frontend/tests/dark-mode-contrast.test.py 的实测），浅底浅字等同看不见。
    const akVars = (item: {bgColor: string, bgColorDark: string}) => ({
        "--ak-bg": item.bgColor,
        "--ak-bg-dark": item.bgColorDark,
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
                    bodyStyle={{padding: 10, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%'}}
                >
                    {item.isComponent ? (
                        <div style={{width: '100%', height: '100%', overflow: 'hidden'}}>
                            <WordCloud />
                        </div>
                    ) : (
                        <div style={{width: '100%'}}>
                            <Statistic title={item.name} value={item.value} formatter={formatter}/>
                        </div>
                    )}
                </Card>
            ))}
        </div>
    </>
}
export default ArticleAnalytics;
