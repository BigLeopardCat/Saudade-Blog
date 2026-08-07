import './index.sass'
import {useEffect, useState} from "react";
import {Friend} from "../../../interface/FriendType";
import {message} from "antd";
import { motion } from 'framer-motion';
import scrollToTop from "../../../utils/scrollToTop.tsx";
import {getFriendsList} from "../../../apis/FriendMethods.tsx";

// A6 修复：渲染前强制 http(s) 协议白名单，防 javascript:/data: 注入 href
const safeSiteUrl = (url: string): string => {
    if (/^https?:\/\//i.test(url)) return url;
    return '#';
};

const FriendList = () => {
    const [Friends,setFriends] = useState<Friend[]>([])
    useEffect(() => {
        scrollToTop();
        initFriendsList()
    },[]);

    const initFriendsList = () => {
        getFriendsList().then((res) => {
            setFriends(res.data.data)
        }).catch(() => {
            message.error("获取失败")
        });
    }

    return <div className='FriendsContainer'>

        <div className="FriendList">
            <h3>Friends</h3>
            <ul className='link-items' style={{gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))'}}>
                {Friends.filter(item=>item.status === 1).map((item,index) => (
                    <motion.div
                        key={index}
                        initial={{ opacity: 0, y: -20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5, delay: index * 0.2 ,ease: "linear"}}
                        className="article"
                        style={{position:'relative'}}
                    >
                        <a key={item.friendKey} href={safeSiteUrl(item.siteUrl)} target='_blank' rel='noopener noreferrer'><li className='link-item'>
                            <div style={{ position: 'absolute', right: 5, top: 5 }}>
                            </div>
                            <img
                                alt={item.siteName}
                                className="lazyload"
                                data-src={item.avatar}
                                src={item.avatar}
                            />
                            <br />
                            <span className="sitename">{item.siteName}</span>
                            <div className="linkdes">{item.description}</div>

                        </li></a></motion.div>))}
            </ul>
        </div>
    </div>
}


export default FriendList