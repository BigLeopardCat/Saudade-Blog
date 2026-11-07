import SweepLoading from '../../../components/SweepLoading'
import AssetImage from "../../../components/AssetImage";
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
    /** Animate new rows; cached rows start visible. */
    enter?: boolean
}

const ENTER_DELAY_STEP = 0.1
const ENTER_DELAY_MAX_STEPS = 5

/** Icons correspond to the normalized stat cell keys. */
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
    // Cached cards skip entrance animation; image fetching uses native lazy loading.
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
                    {isVisible && <AssetImage pending={<SweepLoading/>} alt={item.noteTitle} src={item.cover} style={coverCropStyle(cropFromRow(item))} />}
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