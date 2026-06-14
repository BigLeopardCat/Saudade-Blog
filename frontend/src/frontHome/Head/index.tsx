import {Avatar, Button, Card, ConfigProvider, Modal, message} from 'antd'
import './index.sass'
import {Key, ReactElement, ReactNode, ReactPortal, useEffect, useState} from "react";
import {useNavigate} from "react-router-dom";
import {debounce} from 'lodash';
import Switch from "../../components/Switch";
import SearchButton2 from "../../components/Buttons/SearchButton2";
import TopMao from "../../components/TopMao";
import {fetchCategories} from "../../store/components/categories.tsx";
import {useDispatch, useSelector} from "react-redux";
import {fetchTags} from "../../store/components/tags.tsx";
import {fetchSocial, fetchUserInfo} from "../../store/components/user.tsx";
import {fetchNoteList} from "../../store/components/note.tsx";
import { searchNotes } from "../../apis/NoteMethods.tsx";
import UserState from "../../interface/UserState";
import '../main.css'
import MoonToSun from "../MoonToSun";
import deleteToken from "../../apis/deleteToken.tsx";

interface HeadProps {
    setDark: (value: (((prevState: boolean) => boolean) | boolean)) => void,
    isDark: boolean,
    scrollHeight: number
}

const Head = ({ setDark, isDark, scrollHeight }: HeadProps) => {
    const [showStatus, setShowStatus] = useState(false);
    const [phoneBarShow, setPhoneBarShow] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const [isLogin, setLogin] = useState(0)
    const [showMobileCategory, setShowMobileCategory] = useState(false);
    const dispatch = useDispatch()
    const navigate = useNavigate();
    const [animation,setAnimation] = useState('');
    const categoryList = useSelector((state: any) => state.categories.categories)
    const avatar = useSelector((state:{user:UserState}) => state.user.avatar)
    const blogTitle = useSelector((state:{user:{blogTitle: string}}) => state.user.blogTitle)

    // Search Logic
    const [searchKeyword, setSearchKeyword] = useState('');
    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    useEffect(() => {
        dispatch<any>(fetchCategories())
        dispatch<any>(fetchTags())
        dispatch<any>(fetchUserInfo())
        dispatch<any>(fetchNoteList())
        dispatch<any>(fetchSocial())
        const status = localStorage.getItem('tokenKey')
        if (status !== null) {
            setLogin(1)
        }

    }, []);

    // 定义防抖函数，设置延迟时间为 300 毫秒
    const startAnimationDebounced = debounce(() => {
        setShowStatus(true);
    }, 300);

    const handleMouseEnter = () => {
        startAnimationDebounced();
        setIsHovered(true);
    };

    const handleMouseLeave = () => {
        setShowStatus(false);
        setIsHovered(false);
    };

    const [isModalOpen, setIsModalOpen] = useState(false);

    const showModal = () => {
        setIsModalOpen(true);
    };


    const handleCancel = () => {
        setIsModalOpen(false);
    };

    const handleModeSwitch = () => {
        setDark(!isDark)
        setAnimation(isDark === true ? "sun" : "moon");
        localStorage.setItem("isDarkMode", JSON.stringify(!isDark));
    };

    // Debounced search function
    const performSearch = async (keyword: string) => {
        if(!keyword.trim()) {
            setSearchResults([]);
            return;
        }
        setIsSearching(true);
        try {
            const res = await searchNotes({ keyword: keyword });
            if(res.status === 200) {
                setSearchResults(res.data.data);
            }
        } catch(err) {
            // silent error or message
        } finally {
            setIsSearching(false);
        }
    };

    // Create a memoized debounced version
    const debouncedSearch = debounce(performSearch, 500);

    const onSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setSearchKeyword(val);
        // Clean results if empty
        if (!val.trim()) {
            setSearchResults([]);
            return;
        }
        debouncedSearch(val);
    };

    const handleSearch = async (e: any) => {
         if (e.key === 'Enter') {
             debouncedSearch.cancel(); // cancel pending
             performSearch(searchKeyword);
         }
    }

    const toArticle = (id: number) => {
        setIsModalOpen(false);
        navigate(`article/${id}`);
    }

    return (
        <header style={{display: 'flex', flexDirection: 'row', position: 'sticky', width: '100%', top: 0, zIndex: '999'}} className={isDark ? 'frontDark' : ''}>
            <div className={`${phoneBarShow ? 'openBar' : ''} phoneSide`} style={{position: "sticky"}}>
                <div className="phoneBarContainer">
                    <div className="barLogo">
                        <Avatar
                            src={avatar}
                            size={100}/>
                         <div style={{ marginTop: "5px", display: "flex", justifyContent: "center", gap: "10px" }}>
                            {isLogin ? (
                                <div className="theme-btn" onClick={() => navigate("dashboard")} style={{ padding: "5px 15px", background: "#ace0f9", color: "#fff", borderRadius: "5px", cursor: "pointer", fontSize: "14px" }}>心境</div>
                            ) : (
                                <div className="theme-btn" onClick={() => navigate("login")} style={{ padding: "5px 15px", background: "#ace0f9", color: "#fff", borderRadius: "5px", cursor: "pointer", fontSize: "14px" }}>登录</div>
                            )}
                        </div>
                    </div>
                    <input className="mSearchInput" type="search" placeholder="搜索..." onClick={showModal} readOnly />
                    <div className="barContent">
                        <ul className='oneBar'>
                            <li onClick={() => navigate('')}><i className="iconfont icon-shouye4"
                                                                style={{fontSize: 30}}></i>首页
                            </li>
                            <li onClick={() => navigate('times')}><i className="iconfont icon-guidang3"
                                                                     style={{fontSize: 25}}></i>归档
                            </li>
                            <li onClick={() => setShowMobileCategory(!showMobileCategory)}>
                                <div style={{height: 30}}><i className="iconfont icon-fenlei"
                                         style={{fontSize: 30}}></i>分类</div>
                            </li>
                            {showMobileCategory && <ul className='twoBar'>
                                {categoryList.map((item: { categoryKey: Key | null | undefined; pathName: any; icon: any; categoryTitle: string | number | boolean | ReactElement | Iterable<ReactNode> | ReactPortal | null | undefined; }) => (
                                    <li key={item.categoryKey} onClick={() => navigate(`category/${item.pathName}`)} style={{fontSize: 15}}><i className={`fa ${item.icon}`} aria-hidden="true" style={{verticalAlign: 'middle'}}></i>{item.categoryTitle}</li>
                                ))}
                            </ul>}
                            <li onClick={() => navigate('talk')}><i className="iconfont icon-riji"
                                                                    style={{fontSize: 30}}></i>说说
                            </li>
                            <li onClick={() => navigate('friends')}><i className="iconfont icon-lianjie"
                                                                       style={{fontSize: 30}}></i>友人链
                            </li>
                            <li onClick={() => navigate('about')}><i className="iconfont icon-leaf-01"
                                                                     style={{fontSize: 30}}></i>关于我
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
            <TopMao currentScrollHeight={scrollHeight}/>
            <div className="headContainer" style={{
                margin: scrollHeight ? 0 : '',
                borderRadius: scrollHeight ? 0 : '',
                background: scrollHeight ? 'rgba(0,0,0,0.66)' : '',
                width: scrollHeight ? '100%' : '',
                backdropFilter: scrollHeight ? 'blur(10px)' : ''
            }}>
                <div className="phoneBar">
                    {phoneBarShow ? <i className="iconfont icon-guanbi2" style={{
                            fontSize: 35,
                            marginLeft: 260,
                            cursor: 'pointer',
                            transition: '0.5s'
                        }} onClick={() => setPhoneBarShow(false)}></i> :
                        <i className="iconfont icon-bars"
                           style={{fontSize: 35, marginLeft: 10, cursor: 'pointer', transition: '0.5s'}}
                           onClick={() => setPhoneBarShow(true)}></i>}
                </div>
                <div className="webTitle" onClick={()=>navigate('/')}>
                    <h2><span className="firstTitle">{blogTitle}</span>Blog</h2>
                </div>
                <div className="headBar">
                    <ul>
                        <li onClick={() => navigate('/')}><i className="iconfont icon-shouye4"
                                                             style={{fontSize: 30}}></i>首页
                        </li>
                        <li onClick={() => navigate('times')}><i className="iconfont icon-guidang3"
                                                                 style={{fontSize: 25}}></i>归档
                        </li>
                        <li style={{position: 'relative'}} className='Category'><i
                            className="iconfont icon-fenlei" style={{fontSize: 30}}></i>分类
                            <div className='CategoryList'>
                                <i className="iconfont icon-Rrl_s_045" style={{
                                    fontSize: 40,
                                    position: 'absolute',
                                    left: 25,
                                    top: -29,
                                    color: 'rgba(0, 0, 0, 0.83)'
                                }}></i>
                                <ul>
                                    {categoryList.map((item: { categoryKey: Key | null | undefined; pathName: any; icon: any; categoryTitle: string | number | boolean | ReactElement | Iterable<ReactNode> | ReactPortal | null | undefined; }) => (
                                        <li key={item.categoryKey} onClick={() => navigate(`category/${item.pathName}`)}><i className={`iconfont ${item.icon}`} style={{fontSize: 20}}></i>{item.categoryTitle}</li>
                                    ))}
                                </ul>
                            </div>
                        </li>
                        <li onClick={()=>navigate('talk')}><i className="iconfont icon-liaotian1" style={{fontSize: 30}}></i>说说</li>
                        <li onClick={()=>navigate('friends')}><i className="iconfont icon-lianjie" style={{fontSize: 30}}></i>友人链</li>
                        <li onClick={()=>navigate('about')}><i className="iconfont icon-leaf-01" style={{fontSize: 30}}></i>关于我</li>
                    </ul>
                </div>

                <div className="homeRight">
                    <div onClick={showModal}><SearchButton2 /></div>
                    <div className={'homeSwitch'}><Switch handleModeSwitch={handleModeSwitch} isDarkMode={isDark}/></div>
                    <div className={`homeLogo ${isHovered&&'BigAvatar'}`} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
                        <Avatar src={avatar} size='large'/>
                        <div className="loginCard" style={{
                            display: (showStatus && isHovered) ? 'flex' : 'none',
                            flexDirection: 'column',
                            gap: '5px'
                        }}>
                            {isLogin ? (
                                <div className="theme-btn" onClick={() => navigate("dashboard")}>心境</div>
                            ) : (
                                <div className="theme-btn" onClick={() => navigate("login")}>登录</div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <ConfigProvider
                theme={{
                    token: {
                        boxShadow: 'none'
                    },
                    components: {
                        Modal: {
                            contentBg: 'transparent'
                        },
                    },
                }}
            >
                <Modal open={isModalOpen} onCancel={handleCancel} footer={null} width={'100vh'} >
                    <div style={{height:'80vh'}} className='searchModal'>
                        <div style={{
                                position: 'relative', 
                                width: '80%', 
                                margin: '0 auto',
                                display: 'flex',
                                alignItems: 'center'
                            }}>
                            <input 
                                type="search" 
                                className='searchModalInput' 
                                placeholder={'输入内容自动搜索...'}
                                value={searchKeyword}
                                onChange={onSearchChange}
                                onKeyDown={handleSearch}
                                style={{
                                    width: '100%',
                                    paddingRight: '40px',
                                    flex: 1
                                }}
                            />
                            <i className="iconfont icon-sousuo1" 
                               style={{
                                   position: 'absolute',
                                   right: '15px',
                                   
                                   top: '40%', transform: 'translateY(-50%)', marginBottom: '2px',
                                   fontSize: '25px',
                                   color: '#999',
                                   cursor: 'pointer',
                                   lineHeight: '1',
                                   display: 'flex',
                                   alignItems: 'center'
                               }}
                               onClick={() => performSearch(searchKeyword)}
                            ></i>
                        </div>
                        
                        <Card 
                            style={{
                                width:'80%', 
                                margin: '20px auto 0',
                                height: '85%', 
                                overflowY:'auto', 
                                background: 'transparent', 
                                display: searchKeyword ? 'block' : 'none'
                            }}
                            title={
                                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: isDark ? '#fff' : '#333'}}>
                                    <span style={{
                                        background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.7)',
                                        padding: '4px 8px',
                                        borderRadius: '4px',
                                        fontSize: '14px',
                                        backdropFilter: 'blur(4px)'
                                    }}>
                                        搜索结果 ({searchResults.length})
                                    </span>
                                    {isSearching && <span style={{fontSize: '12px', opacity: 0.7}}>搜索中...</span>}
                                </div>
                            } 
                            bordered={false}
                        >
                             <div className="search-results-list">
                                {searchResults.map((item: any) => (
                                    <div 
                                        key={item.key || item.id} 
                                        onClick={() => toArticle(item.key || item.id)}
                                        className="search-item"
                                        style={{
                                            padding: '12px',
                                            marginBottom: '8px',
                                            borderRadius: '6px',
                                            cursor: 'pointer',
                                            background: isDark ? '#333' : '#f5f5f5',
                                            color: isDark ? '#fff' : '#333',
                                            transition: 'all 0.3s',
                                            border: isDark ? '1px solid #444' : 'none'
                                        }}
                                    >
                                        <div style={{fontWeight: 'bold', fontSize: '16px', marginBottom: '4px'}}>
                                            {item.noteTitle || item.title}
                                        </div>
                                        <div style={{fontSize: '13px', opacity: 0.8, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'}}>
                                            {item.description || item.content?.substring(0, 100)}
                                        </div>
                                    </div>
                                ))}
                                {searchResults.length === 0 && !isSearching && (
                                    <div style={{textAlign: 'center', color: isDark ? '#888' : '#999', padding: '20px'}}>
                                        未找到相关文章
                                    </div>
                                )}
                             </div>
                        </Card>
                    </div>
                </Modal>
            </ConfigProvider>
            {animation !== '' && <MoonToSun status={animation} />}
        </header>
    );
};

export default Head;
