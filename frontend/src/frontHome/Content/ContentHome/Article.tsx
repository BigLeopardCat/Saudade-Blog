import LazyImage from "../../../components/LazyImage";
import {Avatar} from "antd";
import {motion} from "framer-motion";
import {useNavigate} from "react-router-dom";
import React, {useEffect, useRef, useState} from "react";
import {NoteType} from "../../../interface/NoteType";
import {CategoriesType} from "../../../interface/CategoriesType";
import {renderNoteTags} from "../../../apis/TagMethods.tsx";
import dayjs from "dayjs";

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

const Article:React.FC<ArticleOption> = ({ item, index, Categories, avatar, name, tagList }) => {
    const navigate = useNavigate();
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
            <div className="ArticleCard" onClick={() => window.open(`/article/${item.key}`, '_blank')}>
                <div className="ArticleCover">
                    {isVisible && <LazyImage src={item.cover} />}
                </div>

                <div className="ArticleContent">
                    <h4 style={{ color: Categories.find(category => category.categoryTitle === item.noteCategory)?.color }}>
                        # {Categories.filter(category => category.categoryKey === item.noteCategory).map(item => item.categoryTitle)}
                    </h4>
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