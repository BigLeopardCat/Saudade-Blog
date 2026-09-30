import LazyImage from "../../../components/LazyImage";
import {Avatar} from "antd";
import {motion} from "framer-motion";
import React, {useEffect, useRef, useState} from "react";
import {NoteType} from "../../../interface/NoteType";
import {CategoriesType} from "../../../interface/CategoriesType";
import {renderNoteTags} from "../../../apis/TagMethods.tsx";
import dayjs from "dayjs";
import { coverCropStyle, cropFromRow } from "../../../utils/coverCrop";
import { EyeIcon, HeartIcon, StarIcon } from "../../../components/NoteStatIcons/index.tsx";
import { statCells } from "../../../utils/noteStats";

interface tag
{
    tagKey: number;
    color: string;
    title: string;
    children: any[]
}
interface ArticleOption {
    item: NoteType
    index: number
    Categories: CategoriesType[]
    avatar: string
    name: string
    tagList: tag[]
}

/** 三个数各自的图标。**图标在这里、判据在 `utils/noteStats`**——那边是可断言的纯函数
 *  （"读不到 ≠ 0"那条规则），这边只管画。 */
const STAT_ICON: Record<string, React.ReactNode> = {
    views: <EyeIcon size={13} />,
    likes: <HeartIcon size={13} />,
    favorites: <StarIcon size={13} />,
}

/**
 * 卡片上的三个数：阅读 / 点赞 / 收藏（20260930）。
 *
 * 显示哪几个由 `statCells()` 定（后端三条聚合查询可能只挂了一条，"读不到"绝不显示成 0，
 * 见 `utils/noteStats.ts`）；一个数都没有时**整个容器不渲染**，不留一条空白行
 * （父级是 flex，空 div 也会吃掉 gap）。
 */
const NoteStats: React.FC<{ item: NoteType }> = ({ item }) => {
    const cells = statCells(item)
    if (cells.length === 0) return null
    return (
        <div className="ArticleStats">
            {cells.map(cell => (
                <span className="ArticleStat" key={cell.key} title={cell.label}>
                    {STAT_ICON[cell.key]}
                    <span className="ArticleStatNum">{cell.value}</span>
                </span>
            ))}
        </div>
    )
}

const Article:React.FC<ArticleOption> = ({ item, index, Categories, avatar, name, tagList }) => {
    const [isVisible, setIsVisible] = useState(false);
    const elementRef = useRef(null);

    useEffect(() => {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    setIsVisible(true);
                    observer.unobserve(entry.target);
                }
            });
        });

        if (elementRef.current) {
            observer.observe(elementRef.current);
        }

        return () => {
            observer.disconnect();
        };
    }, []);

    return (
        <motion.div
            key={index}
            initial={{ opacity: 0, y: -20 }}
            animate={isVisible ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.5, delay: index * 0.2 }}
            ref={elementRef}
            className="article"
        >
            <div className="ArticleCard" onClick={() => window.open(`/article/${item.key}`, "_blank")}>
                <div className="ArticleCover">
                    {isVisible && <LazyImage src={item.cover} style={coverCropStyle(cropFromRow(item))} />}
                </div>

                <div className="ArticleContent">
                    {/* 分类与读数**同一行**：这一行就是封面图正下方那一行。
                        刻意不给读数单开一行——`.ArticleCard` 是定高 600px，内容区的高度
                        收支在 20260912 已经调到只剩约 7px 余量（见 index.sass 里那段注释），
                        再加一行 20px 会把 `margin-top: auto` 顶掉，同一排卡片的页脚就会
                        高低不齐。挂在这一行上则零高度成本，桌面/移动两套布局都不用改。 */}
                    <div className="ArticleHead">
                        <h4 style={{ color: Categories.find(category => category.categoryTitle === item.noteCategory)?.color }}>
                            # {Categories.find(category => category.categoryKey === item.noteCategory)?.categoryTitle ?? ''}
                        </h4>
                        <NoteStats item={item} />
                    </div>
                    <h3 className='ArticleTitle'>{item.noteTitle}</h3>
                    <p className="ArticleDescription">{item.description}</p>
                    <div style={{ width: '100%', marginTop: 'auto', flexShrink: 0 }}>
                        <div className='tags' style={{ width: '100%', marginTop: '10px' }}>
                            {renderNoteTags(item.noteTags,tagList)}
                        </div>
                        <div className="ArticleFooter" style={{ display: 'flex', alignItems: 'center', paddingBottom: '20px', marginTop: '10px' }}>
                        <Avatar src={avatar} size={40} style={{ marginRight: 10 }} />
                        <span style={{ fontWeight: 'bold', marginRight: 10, lineHeight: '22px', fontSize: '14px' }}>{name}</span>
                        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
                             <span style={{ fontSize: 12, color: '#7f7e7e', lineHeight: '22px' }} className='post-date'>
                                <i className="iconfont icon-naozhong icon" style={{ fontSize: 14, display: 'inline', marginRight: '4px' }}></i>
                                发布于 {dayjs(item.createTime).format('YYYY-MM-DD')}
                             </span>
                             <span style={{ position: 'absolute', top: '100%', marginTop: '6px', left: 0, fontSize: 12, color: '#7f7e7e', lineHeight: '22px', whiteSpace: 'nowrap' }} className='post-date'>
                                <i className="iconfont icon-naozhong icon" style={{ fontSize: 14, display: 'inline', marginRight: '4px' }}></i>
                                更新于 {dayjs(item.updateTime).format('YYYY-MM-DD')}
                             </span>
                        </div>
                    </div>
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default Article;