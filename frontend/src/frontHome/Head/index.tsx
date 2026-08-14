import {Avatar, Button, Card, ConfigProvider, Modal, message} from 'antd'
import './index.sass'
import {Key, ReactElement, ReactNode, ReactPortal, useEffect, useRef, useState} from "react";
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

        // 看板娘 agent 的 DARKMODE: 命令切换夜间模式时，触发与手动点击相同的日月过渡动画
        // （autoload.js applyDarkMode 在状态实际变化时派发 moon-sun-animation）
        const handleMoonSun = (e: Event) => {
            const s = (e as CustomEvent).detail;
            if (s === 'sun' || s === 'moon') setAnimation(s);
        };
        window.addEventListener('moon-sun-animation', handleMoonSun);
        return () => window.removeEventListener('moon-sun-animation', handleMoonSun);
    }, []);

    // 抽屉菜单打开时锁定页面滚动：背景不随手指滑动，仅抽屉内部可滚动
    useEffect(() => {
        if (!phoneBarShow) return;
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onTouchMove = (e: TouchEvent) => {
            const t = e.target as HTMLElement | null;
            if (t && t.closest('.phoneSide')) return; // 抽屉内部放行（自身可滚动）
            e.preventDefault(); // 其余区域禁止滚动（兼容 iOS 橡皮筋）
        };
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        return () => {
            document.body.style.overflow = prevOverflow;
            document.removeEventListener('touchmove', onTouchMove);
        };
    }, [phoneBarShow]);

    // 关闭抽屉菜单（同时收起分类子菜单），所有导航入口共用
    const closePhoneBar = () => { setPhoneBarShow(false); setShowMobileCategory(false); };

    // 定义防抖函数，设置延迟时间为 300 毫秒
    const startAnimationDebounced = debounce(() => {
        setShowStatus(true);
    }, 300);

    // 悬浮宽限期：鼠标短暂离开头像（如滑向按钮、跨过间隙）不立即收回菜单，
    // 避免"刚移出一点按钮就消失"。重新进入时取消宽限计时。
    const hoverLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleMouseEnter = () => {
        if (hoverLeaveTimer.current) {
            clearTimeout(hoverLeaveTimer.current);
            hoverLeaveTimer.current = null;
        }
        startAnimationDebounced();
        setIsHovered(true);
    };

    const handleMouseLeave = () => {
        if (hoverLeaveTimer.current) clearTimeout(hoverLeaveTimer.current);
        hoverLeaveTimer.current = setTimeout(() => {
            setShowStatus(false);
            setIsHovered(false);
        }, 200);
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
        // 同步看板娘 agent 的全局状态：autoload.js 监听 darkmode-change 更新 __darkMode，
        // 否则页面内手动切换后 current_darkmode 上报陈旧值，agent 感知只能靠对话记忆
        try { window.dispatchEvent(new CustomEvent('darkmode-change', { detail: !isDark })); } catch (e) {/* ignore */}
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
        <>
            {phoneBarShow && <div className="phoneSideOverlay" onClick={() => setPhoneBarShow(false)} />}
        <header style={{display: 'flex', flexDirection: 'row', position: 'sticky', width: '100%', top: 0, zIndex: '999'}} className={isDark ? 'frontDark' : ''} onClick={() => { if (phoneBarShow) setPhoneBarShow(false); }}>
            <div className={`${phoneBarShow ? 'openBar' : ''} phoneSide`} style={{position: "sticky"}} onClick={(e) => e.stopPropagation()}>
                <div className="phoneBarContainer">
                    <div className="barLogo">
                        <Avatar
                            src={avatar}
                            size={100}/>
                         <div style={{ marginTop: "5px", display: "flex", justifyContent: "center", gap: "10px" }}>
                            {isLogin ? (
                                <>
                                <div className="theme-btn" onClick={() => { closePhoneBar(); navigate("dashboard"); }}>心境</div>
                                <div className="theme-btn logout-btn" onClick={() => { closePhoneBar(); localStorage.removeItem('tokenKey'); setLogin(0); navigate('/'); }}>退出</div>
                                </>
                            ) : (
                                <div className="theme-btn" onClick={() => { closePhoneBar(); navigate("login"); }}>登录</div>
                            )}
                        </div>
                    </div>
                    <input className="mSearchInput" type="search" placeholder="搜索..." onClick={() => { closePhoneBar(); showModal(); }} readOnly />
                    <div className="barContent">
                        <ul className='oneBar'>
                            <li onClick={() => { closePhoneBar(); navigate('/'); }}><i className="iconfont icon-shouye4"
                                                                style={{fontSize: 30}}></i>首页
                            </li>
                            <li onClick={() => { closePhoneBar(); navigate('times'); }}><i className="iconfont icon-guidang3"
                                                                     style={{fontSize: 25}}></i>归档
                            </li>
                            <li onClick={() => setShowMobileCategory(!showMobileCategory)}>
                                <div style={{height: 30}}><i className="iconfont icon-fenlei"
                                         style={{fontSize: 30}}></i>分类</div>
                            </li>
                            {showMobileCategory && <ul className='twoBar'>
                                {categoryList.map((item: { categoryKey: Key | null | undefined; pathName: any; icon: any; categoryTitle: string | number | boolean | ReactElement | Iterable<ReactNode> | ReactPortal | null | undefined; }) => (
                                    <li key={item.categoryKey} onClick={() => { closePhoneBar(); navigate(`category/${item.pathName}`); }} style={{fontSize: 15}}><i className={`fa ${item.icon}`} aria-hidden="true" style={{verticalAlign: 'middle'}}></i>{item.categoryTitle}</li>
                                ))}
                            </ul>}
                            <li onClick={() => { closePhoneBar(); navigate('talk'); }}><i className="iconfont icon-riji"
                                                                    style={{fontSize: 30}}></i>说说
                            </li>
                            <li onClick={() => { closePhoneBar(); navigate('friends'); }}><i className="iconfont icon-lianjie"
                                                                       style={{fontSize: 30}}></i>友人链
                            </li>
                            <li onClick={() => { closePhoneBar(); navigate('about'); }}><i className="iconfont icon-leaf-01"
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
                            transition: '0.5s',
                            color: 'rgba(255,0,0,0.7)'
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
                                <>
                                <div className="theme-btn" onClick={() => navigate("dashboard")}>心境</div>
                                <div className="theme-btn logout-btn" onClick={() => { localStorage.removeItem('tokenKey'); setLogin(0); navigate('/'); }}>退出</div>
                                </>
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
        </>
    );
};

export default Head;
