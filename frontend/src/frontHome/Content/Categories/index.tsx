import './index.sass'
import { useEffect, useState } from "react";
import {useNavigate, useParams} from "react-router-dom";
import { useSelector } from "react-redux";
import { categoryList } from "../../../store/components/categories.tsx";
import {NoteType} from "../../../interface/NoteType";
import { motion } from "framer-motion";
import dayjs from "dayjs";
import scrollToTop from "../../../utils/scrollToTop.tsx";
import {searchNotes} from "../../../apis/NoteMethods.tsx";
import {useLiveRefresh} from "../../../utils/liveRefresh.ts";
import {message} from "antd";
import LazyImage from "../../../components/LazyImage";
import SeoHelmet from "../../../components/SeoHelmet";
const Categories = () => {
    const { id } = useParams();
    const [categoryTitle, setCategoryTitle] = useState('');
    const [articleList, setArticleList] = useState([]);
    const categories = useSelector((state: { categories: categoryList }) => state.categories.categories);
    const navigate = useNavigate()

    /** 拉这一分类下的公开文章。抽成函数是为了让"跨端同步"能复用同一条路径
     *  （条件、错误提示都只有一份，不再长一条只在事件里走、换个分类就拉错的旁路）。 */
    const loadArticles = () => {
        const title = categories.find(item => item.pathName === id);
        if (!title) return;
        setCategoryTitle(title.categoryTitle);
        return searchNotes({
            categories: title.categoryTitle,
            status: 'public'
        }).then((res) => {
            setArticleList(res.data.data)
        }).catch(() => {
            message.error("获取失败")
        });
    };

    useEffect(() => {
        scrollToTop();
        loadArticles();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, categories]);

    /* 跨端同步（20260926，**不轮询**）：看板娘刚改了站内数据（新建/删除文章、改状态）
       时，访客正看着的这份列表也该跟着变——但访客页面**不为我自己的编辑加流量**：
       只吃"看板娘一轮收尾"这个事件与"切回可见/重新聚焦"，不挂定时器（同首页/详情页）。
       这就是本轮选择"事件 + 可见性 + 轻轮询"而不是 SSE/WS 的那条边界：成本只在后台。 */
    useLiveRefresh(loadArticles, { poll: false });

    return (
        <div className="CategoriesContainer">
            <SeoHelmet title={categoryTitle ? `分类-${categoryTitle}` : '分类'} url={`/category/${id}`} />
            <h2>分类-{categoryTitle}</h2>
            <h3>共有{articleList.length}篇文章</h3>
            <ul className='ArticleList'>
                {articleList.map((item: NoteType,index) =>
                    <motion.div
                        key={index}
                        initial={{ opacity: 0, y: -20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.1, delay: index * 0.2 ,ease: "linear"}}
                        className="article"
                        onClick={() => navigate(`/article/${item.noteKey}`)}
                    >
                    <li>
                        <LazyImage src={item.cover}/>
                        <div className='article'>
                            <div className="articleTop">
                                <h2>{item.noteTitle}</h2>
                                {item.isTop===1&&<span><i
                                    className="iconfont icon-tuding" style={{fontSize: 23,color:'red'}}></i></span>}
                            </div>
                            <p>{item.description}</p>
                            <div className='articleFooter'><span style={{fontSize:13,color:'#7f7e7e'}} className='post-date'><i className="iconfont icon-naozhong icon" style={{fontSize: 22, display: 'inline',verticalAlign: 'sub'}}></i>发布于 {dayjs(item.updateTime).format('YYYY-MM-DD')}</span>
                                <span style={{color:'#ed5f96',float:'right'}}>阅读全文→</span>
                            </div>
                        </div>
                    </li>
                </motion.div>)}
            </ul>
        </div>
    );
}

export default Categories;
