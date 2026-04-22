import './index.sass'
import {Avatar, Tag} from "antd";
import SocialButton from "../../../components/Buttons/SocialButton";
import {useEffect,  useState} from "react";
import {useSelector} from "react-redux";
import UserState from "../../../interface/UserState";
import { motion } from 'framer-motion';
import {formatNote, NoteType} from "../../../interface/NoteType";
import {categoryList} from "../../../store/components/categories.tsx";
import Article from "./Article.tsx";
import {useNavigate} from "react-router-dom";
import {SocialType} from "../../../interface/SocialType";
import {getNotePage, getTopNotes} from "../../../apis/NoteMethods.tsx";
import dayjs from "dayjs";

let cachedOtherArticles: NoteType[] = [];
let cachedTopArticles: NoteType[] = [];
let cachedCurrentPage = 1;
let cachedHasMoreArticles = true;
let isCachedOther = false;

const ContentHome = () => {
    const [currentTop,setCurrentTop] = useState(0)
    const [currentPage,setCurrentPage] = useState(cachedCurrentPage)
    const [hasMoreArticles, setHasMoreArticles] = useState(cachedHasMoreArticles);
    const [loading, setLoading] = useState(false);
    const avatar = useSelector((state:{user:UserState}) => state.user.avatar)
    const name = useSelector((state:{user:UserState}) => state.user.name)
    const oneSay = useSelector((state:{user:UserState}) => state.user.talk)
    const navigate = useNavigate()
    const [otherArticles,setOtherArticles] = useState<NoteType[]>(cachedOtherArticles)
    const [topArticles,setTopArticles] = useState<NoteType[]>(cachedTopArticles)
    const Categories = useSelector((state: { categories: categoryList }) => state.categories.categories);
    const tagList = useSelector((state: {tags: any}) => state.tags.tag)
    const social = useSelector((state:{user:{social: SocialType}}) => state.user.social)
    const author =  useSelector((state: { user: UserState }) => state.user.name);

    useEffect(() => {
        const timer = setInterval(() => {
            setCurrentTop(prevTop => (prevTop + 1) % topArticles.length);
        }, 3000);
        if(topArticles.length === 0)
            clearInterval(timer)
        return () => clearInterval(timer);
    },[currentTop])

    useEffect(() => {
        if (isCachedOther) return;
        getNotePage({
            page: 1,
            pageSize: 6
        }).then(res => {
             const mapped = res.data.data.map((item: formatNote) => {
                return {
                    ...item,
                    key: item.noteKey,
                    noteTags: item.noteTags ? item.noteTags.split(',').map(tag => parseInt(tag, 10)) : [],
                }
            });
            setOtherArticles(mapped);
            cachedOtherArticles = mapped;
            isCachedOther = true;
        })
    }, []);

    useEffect(() => {
        if (cachedTopArticles.length > 0) return;
        getTopNotes().then(res => {
             const mapped = res.data.data.map((item: formatNote) => {
                return {
                    ...item,
                    key: item.noteKey,
                    noteTags: item.noteTags ? item.noteTags.split(',').map(tag => parseInt(tag, 10)) : [],
                }
            });
            setTopArticles(mapped);
            cachedTopArticles = mapped;
        })
    }, []);
    const handleScrollDown = () => {
        window.scrollTo({
            top: window.innerHeight,
            behavior: 'smooth'
        });
    }
    const getMore = () => {
        setLoading(true)
        getNotePage({
            page: currentPage + 1,
            pageSize: 6
        }).then(res => {
            if (res.data.data.length === 0) {
                setHasMoreArticles(false); cachedHasMoreArticles = false;;
            } else {
                setCurrentPage(currentPage + 1); cachedCurrentPage = currentPage + 1;
                setOtherArticles(prevArticles => {
                    const newArts = [
                        ...prevArticles,
                        ...res.data.data.map((item: formatNote) => ({
                            ...item,
                            key: item.noteKey,
                            noteTags: item.noteTags ? item.noteTags.split(',').map(tag => parseInt(tag, 10)) : [],
                        }))
                    ];
                    cachedOtherArticles = newArts;
                    return newArts;
                });
                if(res.data.data.length < 6) { setHasMoreArticles(false); cachedHasMoreArticles = false; }
            }
        }).finally(() => {
            setLoading(false);
        });
    };

    return <>
        <div className="SelfDescription">
            <div className="SayWords">
               <div>
                   <h2>Hi!👋</h2>
                   <h2>I'm <span style={{color: '#7880d1'}}>{author}</span></h2>
               </div>
                <h3 className="home-title-h3">Sereno da Saudade</h3>
                <div className="Social">
                    <SocialButton SocialName='QQ' url={social?.socialQQ}/>
                    <SocialButton SocialName='Github' url={social?.socialGithub}/>
                    <SocialButton SocialName='Netease' url={social?.socialNeteaseCloud}/>
                    <SocialButton SocialName='Email' url={social?.socialEmail}/>
                </div>
            </div>
            <Avatar src={avatar} size={320} className='frontAvatar'/>
            <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1 }}
                style={{display:'flex',width:'200px',justifyContent:'center',bottom:'0',position:"absolute"}}
            >
            <p className="home-one-say" style={{position:'absolute',bottom:"20px", whiteSpace: "nowrap", font: '600 12px ""'}}>{oneSay}</p>
                <i className="iconfont icon-rcd-angle-double-down upAndDown" style={{fontSize: 50,position:"absolute",bottom: 20,color:'skyblue'}} onClick={handleScrollDown}/></motion.div>
        </div>
        <div className="ContentContainer dark-pic">
            {topArticles.length>0&&<div className="TopArticle" onClick={() => window.open(`/article/${topArticles[currentTop]?.key}`, '_blank')}>
                <div className="Top" style={{transform: 'translateY(-40%)'}}><i className="iconfont icon-sticky1" style={{fontSize: 20,verticalAlign:'middle',marginRight:5}}></i>置顶</div>
                <div className="TopCover">
                    {topArticles.map((item,index) => (
                        <img
                            src={item.cover}
                            key={item.key}
                            className={currentTop === index ? 'fade-in-out show' : 'fade-in-out'}
                        />
                    ))}

                    <span className="thumbnail-screen"></span>
                    <div className="topDots">
                        {topArticles.map((item,index) => <div className={`topDot ${currentTop===index&&'dotCurrent'}`} key={item.key} onMouseEnter={()=>setCurrentTop(index)}></div>)}
                    </div>
                </div>
                <div className="topContent">
                    <h4># {Categories.find(item => item.categoryKey === topArticles[currentTop]?.noteCategory)?.categoryTitle}</h4>
                    <h3 className="contentTitle">{topArticles[currentTop]?.noteTitle}</h3>
                    <p> {topArticles[currentTop]?.description}</p>
                    <div className='tags' style={{ width: '100%', marginTop: '10px' }}>
                        {topArticles[currentTop]?.noteTags.map(noteTag => {
                            let color;
                            let name;
                            tagList.forEach((tag: { tagKey: number; color: string; title: string; children: any[]; }) => {
                                if (tag.tagKey === noteTag) {
                                    color = tag.color;
                                    name = tag.title;
                                } else if (tag.children && tag.children.some(child => child.tagKey === noteTag)) {
                                    color = tag.color;
                                    name = tag.children.find(child => child.tagKey === noteTag).title;
                                }
                            });

                            return (
                                <Tag color={color} key={noteTag} style={{ margin: 5 }}>
                                    {name}
                                </Tag>
                            );
                        })}
                    </div>
                    <div className="topFooter" style={{ display: 'flex', alignItems: 'center', paddingBottom: '20px' }}>
                        <Avatar src={avatar} size={40} style={{ marginRight: 10 }} />
                        <span style={{ fontWeight: 'bold', marginRight: 10, lineHeight: '22px', fontSize: '14px' }}>{name}</span>
                        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
                             <span style={{ fontSize: 12, color: '#7f7e7e', lineHeight: '22px' }} className='post-date'>
                                <i className="iconfont icon-naozhong icon" style={{ fontSize: 14, display: 'inline', marginRight: '4px' }}></i>
                                发布于 {dayjs(topArticles[currentTop]?.createTime).format('YYYY-MM-DD')}
                             </span>
                             <span style={{ position: 'absolute', top: '100%', marginTop: '6px', left: 0, fontSize: 12, color: '#7f7e7e', lineHeight: '22px', whiteSpace: 'nowrap' }} className='post-date'>
                                <i className="iconfont icon-naozhong icon" style={{ fontSize: 14, display: 'inline', marginRight: '4px' }}></i>
                                更新于 {dayjs(topArticles[currentTop]?.updateTime).format('YYYY-MM-DD')}
                             </span>
                        </div>
                    </div>
                </div>
            </div>}


        {/*  其他文章  */}
            <div style={{width:'80%', display: 'flex', marginBottom: '20px'}}>
                <div className='allContent'><i className="iconfont icon-wenzhang2" style={{fontSize: 25,verticalAlign:'sub',marginRight:5,color:'#7f7e7e'}}></i>文章</div>
            </div>

            <div className="allArticles">

                {otherArticles.map((item,index) => (
                    <Article item={item} index={index} Categories={Categories} avatar={avatar} name={name} tagList={tagList} key={index}/>
                ))}
            </div>
            {loading ? (
                <div className="loadingio-spinner-spinner-69tfms83mg9">
                    <div className="ldio-se504dvlmh">
                        <div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div>
                    </div>
                </div>
            ) : (
                <div>
                    {hasMoreArticles ? (
                        <div className='allContent more' style={{ padding: '20px 50px 20px 50px', borderRadius: 20, fontSize: 20 }} onClick={getMore}>More</div>
                    ) : null}
                </div>
            )}
        </div>
    </>
}

export default ContentHome