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
        path: string
        isComponent?: boolean
    }[] = [
        {
            index: 1,
            name: <p><span className="logo2" style={{ backgroundColor: 'rgba(230,240,0,0.3)'}}>✨️</span>文章总数</p>,
            value: noteCount,
            bgColor: '#f1dfba',
            path: '/dashboard/notes'
        },
        {
            index: 2,
            name: <p><span className="logo2" style={{ backgroundColor: 'rgba(255,0,0,0.3)'}}>❤️️</span>分类总数</p>,
            value: categoryCount,
            bgColor: '#fbcbd5',
            path: '/dashboard/notes/allcategorize'
        },
        {
            index: 3,
            name: <p><span className="logo2" style={{ backgroundColor: 'rgb(147,154,216,0.3)'}}>🎯</span>标签总数</p>,
            value: tagCount,
            bgColor: '#91ccef',
            path: '/dashboard/notes/alltags'
        }
    ]
    const formatter = (value: React.ReactText): React.ReactNode => (
        <CountUp end={Number(value)} separator="," />
    );

    return <>
        <div className="analyticsCard">
            {list.map(item => (
                <Card 
                    className='akCard' 
                    key={item.index} 
                    style={{backgroundColor:item.bgColor, cursor: item.path ? 'pointer' : 'default'}}
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
