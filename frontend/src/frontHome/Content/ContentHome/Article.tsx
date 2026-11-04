import LazyImage from "../../../components/LazyImage";
import NoteByline from "../../../components/NoteByline";
import {motion} from "framer-motion";
import React, {useEffect, useRef, useState} from "react";
import {NoteType} from "../../../interface/NoteType";
import {CategoriesType} from "../../../interface/CategoriesType";
import {renderNoteTags} from "../../../apis/TagMethods.tsx";
import { coverCropStyle, cropFromRow } from "../../../utils/coverCrop";
import { CommentIcon, EyeIcon, HeartIcon, StarIcon } from "../../../components/NoteStatIcons/index.tsx";
import { statCells } from "../../../utils/noteStats";
import { resetDescScroll } from "../../../utils/descHover";

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
    /**
     * 入场动画（`opacity 0 → 1` + `y: -20 → 0`，逐张延迟）是否启用，默认启用。
     *
     * 首页把「这一屏是不是现拉的」传进来（见 `ContentHome/index.tsx` 的 `enterAnimation`）：
     * 命中模块级缓存时**必须传 false** —— 数据早就躺在内存里，卡片还是照放一遍逐张入场，
     * 用户看到的就是"点回首页 → 先看见一片空白 → 卡片一张张冒出来"，纯等待、零信息。
     */
    enter?: boolean
}

const ENTER_DELAY_STEP = 0.1
const ENTER_DELAY_MAX_STEPS = 5

/** 几个数各自的图标。**图标在这里、判据在 `utils/noteStats`**——那边是可断言的纯函数
 *  （"读不到 ≠ 0"那条规则），这边只管画。键必须与 `StatCell['key']` 一一对应：
 *  加一个数而这里漏一个键，画出来就是"数字前面空一格"（`STAT_ICON[key]` 为 undefined，
 *  不报错、也不崩，只是缺个图）。 */
const STAT_ICON: Record<string, React.ReactNode> = {
    views: <EyeIcon size={13} />,
    likes: <HeartIcon size={13} />,
    favorites: <StarIcon size={13} />,
    comments: <CommentIcon size={13} />,
}

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

const Article:React.FC<ArticleOption> = ({ item, index, Categories, avatar, name, tagList, enter = true }) => {
    // 不放动画的那一档直接起手就可见：既省掉观察器，也保证下面 `{isVisible && <LazyImage/>}`
    // 那道门是开的（封面图本身仍由 LazyImage 自己的 IntersectionObserver 决定何时真去取，
    // 所以这里"立刻挂载"不等于"立刻下载 N 张图"）。
    const [isVisible, setIsVisible] = useState(!enter);
    const elementRef = useRef(null);

    useEffect(() => {
        if (!enter) return;
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
    }, [enter]);

    return (
        <motion.div
            key={index}
            // `initial={false}` = framer-motion 的"不做入场动画"，直接以 `animate` 的值渲染
            // （写 `{}` 或 `{opacity: 1, y: 0}` 都拦不住它先渲染 `initial` 那一帧）
            initial={enter ? { opacity: 0, y: -20 } : false}
            animate={isVisible ? { opacity: 1, y: 0 } : {}}
            transition={enter
                ? { duration: 0.5, delay: Math.min(index, ENTER_DELAY_MAX_STEPS) * ENTER_DELAY_STEP }
                : { duration: 0 }}
            ref={elementRef}
            className="article"
        >
            <div className="ArticleCard" onClick={() => window.open(`/article/${item.key}`, "_blank")}>
                <div className="ArticleCover">
                    {isVisible && <LazyImage src={item.cover} style={coverCropStyle(cropFromRow(item))} />}
                </div>

                <div className="ArticleContent">
                    <div className="ArticleHead">
                        <h4 style={{ color: Categories.find(category => category.categoryTitle === item.noteCategory)?.color }}>
                            # {Categories.find(category => category.categoryKey === Number(item.noteCategory))?.categoryTitle ?? ''}
                        </h4>
                        <NoteStats item={item} />
                    </div>
                    <h3 className='ArticleTitle'>{item.noteTitle}</h3>
                    <div className="descSlot">
                        <p className="ArticleDescription" onMouseLeave={resetDescScroll}>{item.description}</p>
                    </div>
                    <div style={{ width: '100%', marginTop: 'auto', flexShrink: 0 }}>
                        <div className='tags' style={{ width: '100%', marginTop: '10px' }}>
                            {renderNoteTags(item.noteTags,tagList,item.noteTagRefs)}
                        </div>
                        <div className="ArticleFooter" style={{ display: 'flex', alignItems: 'center', paddingBottom: '20px', marginTop: '10px' }}>
                        <NoteByline item={item} siteAvatar={avatar} siteName={name} />
                    </div>
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default Article;