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
}

const ENTER_DELAY_STEP = 0.1
const ENTER_DELAY_MAX_STEPS = 5

const Article:React.FC<ArticleOption> = ({ item, index, Categories, avatar, name, tagList, enter = true }) => {
    // Cached cards skip entrance animation; image fetching uses native lazy loading.
    const [isVisible, setIsVisible] = useState(!enter);
    const elementRef = useRef(null);
    const reduced = useReducedMotion();
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
            initial={enter && !reduced ? { opacity: 0, y: -20 } : false}
            animate={isVisible ? { opacity: 1, y: 0 } : {}}
            transition={enter && !reduced
                ? { duration: 0.5, delay: Math.min(index, ENTER_DELAY_MAX_STEPS) * ENTER_DELAY_STEP }
                : { duration: 0 }}
            ref={elementRef}
            className="article"
        >
            <ArticleCard item={item} categories={Categories} avatar={avatar} name={name} tags={tagList}
                imageVisible={isVisible} newTab/>
        </motion.div>
    );
};

export default Article;
