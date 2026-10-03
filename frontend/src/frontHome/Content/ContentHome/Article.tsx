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

/** 入场延迟的步长与上限（20261004）。原来是 `delay: index * 0.2` 且**不封顶**：
 *  第一行看着是好看的 0/0.2/0.4 阶梯，但延迟是按下标线性长的 —— 第 20 张卡要等 **4 秒**
 *  才淡入，而它的 `isVisible` 是由 IntersectionObserver 在**滚到它跟前**才置位的，
 *  于是"滚到哪儿等几秒"完全由一个跟可见性无关的序号决定。封顶之后最坏 0.5s。 */
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
    // 讨论数（20261003 用户第 4 条）。与详情页那一列同源同尺寸，只是卡片档小一号（13）
    comments: <CommentIcon size={13} />,
}

/**
 * 卡片上的几个数：阅读 / 点赞 / 收藏 / 讨论（20260930，20261003 补讨论）。
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
                    {/* `.descSlot` 是定高槽（桌面 60px = 3 行），简介在槽内绝对定位 ⇒
                        展开/收回整个不参与布局，标签与页脚（`margin-top: auto` 钉在卡底）
                        悬浮期间一个像素都不动。槽本身不能省——去掉它简介就会回到 flex 流里，
                        又会被压出半行（见 index.sass 里 `.descSlot` 那段注释）。
                        展开/收回全靠 CSS（`.ArticleDescription:hover`），只有"离开时把滚位抹回
                        顶部"这一件事 CSS 做不到——`overflow: hidden` 的盒子也是滚动容器，滚过之后
                        静置态会停在全文中段。判据与理由见 `utils/descHover.ts`。 */}
                    <div className="descSlot">
                        <p className="ArticleDescription" onMouseLeave={resetDescScroll}>{item.description}</p>
                    </div>
                    <div style={{ width: '100%', marginTop: 'auto', flexShrink: 0 }}>
                        <div className='tags' style={{ width: '100%', marginTop: '10px' }}>
                            {renderNoteTags(item.noteTags,tagList)}
                        </div>
                        <div className="ArticleFooter" style={{ display: 'flex', alignItems: 'center', paddingBottom: '20px', marginTop: '10px' }}>
                        {/* 头像 + 署名 + 两个日期（20261001）：这段标记与置顶轮播那份逐字相同，
                            已抽到 `components/NoteByline`。这里传进去的 `avatar`/`name` 是
                            **站点级兜底**（redux `state.user`），文章自己有作者记录时用文章那份。 */}
                        <NoteByline item={item} siteAvatar={avatar} siteName={name} />
                    </div>
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

export default Article;