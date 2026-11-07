import SweepLoading from '../../../components/SweepLoading'
import './index.sass'
import { useEffect, useRef, useState } from "react";
import {useNavigate, useParams} from "react-router-dom";
import { useSelector } from "react-redux";
import { categoryList } from "../../../store/components/categories.tsx";
import {NoteType} from "../../../interface/NoteType";
import { motion } from "framer-motion";
import dayjs from "dayjs";
import scrollToTop from "../../../utils/scrollToTop.tsx";
import {searchNotes} from "../../../apis/NoteMethods.tsx";
import {useLiveRefresh} from "../../../utils/liveRefresh.ts";
import {ok} from "../../../apis/ProfileMethods";
import {createRequestScope} from "../../../utils/requestScope";
import AssetImage from "../../../components/AssetImage";
import SeoHelmet from "../../../components/SeoHelmet";
const CategoryResource = ({id, categoryTitle}: {id: string, categoryTitle?: string}) => {
    const [articleList, setArticleList] = useState<NoteType[]>([]);
    const [loading, setLoading] = useState(!!categoryTitle);
    const [failed, setFailed] = useState(false);
    const scope = useRef(createRequestScope()).current;
    const navigate = useNavigate();

    const loadArticles = () => {
        if (!categoryTitle) return;
        setFailed(false);
        return scope.run('articles', signal => searchNotes({
            categories: categoryTitle,
            status: 'public'
        }, signal), {
            success: (res) => {
                if (!ok(res) || !Array.isArray(res.data.data)) throw new Error('获取失败');
                setArticleList(res.data.data);
            },
            error: () => setFailed(true),
            settled: () => setLoading(false),
        });
    };

    useEffect(() => {
        scope.activate();
        scrollToTop();
        loadArticles();
        return () => scope.dispose();
        // The keyed resource is replaced whenever id or title changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useLiveRefresh(loadArticles, { poll: false });

    return (
        <div className="CategoriesContainer">
            <SeoHelmet title={categoryTitle ? `分类-${categoryTitle}` : '分类'} url={`/category/${id}`} />
            <h2>分类{categoryTitle ? `-${categoryTitle}` : ''}</h2>
            {!categoryTitle ? <p role="status">分类不存在或分类目录尚未加载，请稍后重试。</p>
                : loading ? <p role="status">正在加载文章…</p>
                : failed ? <p role="alert">文章列表加载失败，<button type="button" onClick={loadArticles}>重试</button></p>
                : <h3>共有{articleList.length}篇文章</h3>}
            {categoryTitle && !loading && !failed && articleList.length === 0 && <p>这个分类还没有公开文章。</p>}
            <ul className='ArticleList'>
                {articleList.map((item: NoteType,index) =>
                    <motion.div
                        key={item.noteKey}
                        initial={{ opacity: 0, y: -20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.1, delay: Math.min(index, 6) * 0.06 ,ease: "linear"}}
                        className="article"
                        onClick={() => navigate(`/article/${item.noteKey}`)}
                    >
                    <li>
                        <AssetImage pending={<SweepLoading/>} alt={item.noteTitle} src={item.cover}/>
                        <div className='article'>
                            <div className="articleTop">
                                <h2>{item.noteTitle}</h2>
                                {item.isTop===1&&<span><i
                                    className="iconfont icon-tuding" style={{fontSize: 23,color:'var(--washi-pink-deep)'}}></i></span>}
                            </div>
                            <p>{item.description}</p>
                            <div className='articleFooter'><span style={{fontSize:13,color:'var(--font-p-color)'}} className='post-date'><i className="iconfont icon-naozhong icon" style={{fontSize: 22, display: 'inline',verticalAlign: 'sub'}}></i>发布于 {dayjs(item.updateTime).format('YYYY-MM-DD')}</span>
                                <span style={{color:'var(--washi-pink-deep)',float:'right'}}>阅读全文→</span>
                            </div>
                        </div>
                    </li>
                </motion.div>)}
            </ul>
        </div>
    );
}

const Categories = () => {
    const {id = ''} = useParams();
    const categories = useSelector((state: {categories: categoryList}) => state.categories.categories);
    const title = categories.find(item => item.pathName === id)?.categoryTitle;
    return <CategoryResource key={JSON.stringify([id, title])} id={id} categoryTitle={title} />;
}

export default Categories;
