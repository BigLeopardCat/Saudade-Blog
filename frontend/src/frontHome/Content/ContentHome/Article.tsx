import '../../../scene.css'
import ArticleCard from '../../../components/ArticleCard'
import {motion, useReducedMotion} from 'framer-motion'
import React, {useEffect, useRef, useState} from 'react'
import type {NoteType} from '../../../interface/NoteType'
import type {CategoriesType} from '../../../interface/CategoriesType'

interface tag
{
    tagKey: number;
    color: string;
    title: string;
    children: any[]
}
export interface ArticleOption {
    item: NoteType
    index: number
    Categories: CategoriesType[]
    avatar: string
    name: string
    tagList: tag[]
    /** Animate new rows; cached rows start visible. */
    enter?: boolean
    expanded?: boolean
    layoutKey?: string | null
    onExpand?: (open: boolean) => void
}

const ENTER_DELAY_STEP = 0.1
const ENTER_DELAY_MAX_STEPS = 5

const Article:React.FC<ArticleOption> = ({ item, index, Categories, avatar, name, tagList, enter = true, expanded = false, layoutKey, onExpand }) => {
    // Cached cards skip entrance animation; image fetching uses native lazy loading.
    const [isVisible, setIsVisible] = useState(!enter);
    const elementRef = useRef(null);
    const reduced = useReducedMotion();
    const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
    const closeTimer = useRef<ReturnType<typeof setTimeout>>();
    useEffect(() => () => { clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current); }, []);


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
            key={item.key}
            layout={reduced ? false : true}
            layoutDependency={layoutKey}
            data-expanded={expanded}
            onPointerEnter={event => {
                if (event.pointerType !== 'mouse') return;
                clearTimeout(closeTimer.current);
                hoverTimer.current = setTimeout(() => onExpand?.(true), 320);
            }}
            onPointerLeave={() => {
                clearTimeout(hoverTimer.current);
                closeTimer.current = setTimeout(() => onExpand?.(false), 550);
            }}
            onFocusCapture={event => { if ((event.target as HTMLElement).matches(':focus-visible')) onExpand?.(true); }}
            onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) onExpand?.(false); }}
            initial={enter && !reduced ? { opacity: 0, y: -20 } : false}
            animate={isVisible ? { opacity: 1, y: 0 } : {}}
            transition={enter && !reduced
                ? { duration: 0.5, delay: Math.min(index, ENTER_DELAY_MAX_STEPS) * ENTER_DELAY_STEP, layout: {duration: .36, ease: [.22, 1, .36, 1]} }
                : { duration: 0, layout: {duration: .36, ease: [.22, 1, .36, 1]} }}
            ref={elementRef}
            className="article"
        >
            <ArticleCard item={item} categories={Categories} avatar={avatar} name={name} tags={tagList}
                imageVisible={isVisible} expanded={expanded} newTab/>
        </motion.div>
    );
};

export default Article;
