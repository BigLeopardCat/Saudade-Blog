import './index.sass'
import {useEffect, useState} from "react";
import {useParams} from "react-router-dom";
import {NoteType} from "../../../interface/NoteType";
import { motion } from 'framer-motion';
import {Avatar, Flex} from "antd";
import {useSelector} from "react-redux";
import UserState from "../../../interface/UserState";
import dayjs from "dayjs";
import MarkdownNavbar from 'markdown-navbar'
import 'markdown-navbar/dist/navbar.css'
import Loading from "../../Loading";
import scrollToTop from "../../../utils/scrollToTop.tsx";
import {getNoteById} from "../../../apis/NoteMethods.tsx";

// ByteMD imports
import { Viewer } from '@bytemd/react'
import gfm from '@bytemd/plugin-gfm'
import breaks from "@bytemd/plugin-breaks";
import frontmatter from "@bytemd/plugin-frontmatter";
import gemoji from "@bytemd/plugin-gemoji";
import highlight from "@bytemd/plugin-highlight";
import mediumZoom from '@bytemd/plugin-medium-zoom'
import 'bytemd/dist/index.css'
import 'github-markdown-css/github-markdown-light.css'
import 'highlight.js/styles/atom-one-dark.css' // Import Highlight.js styles

const plugins = [
    gfm(),
    breaks(),
    frontmatter(),
    gemoji(),
    highlight(),
    mediumZoom()
]

const ReadArticle = () => {
    const avatar = useSelector((state:{user:UserState}) => state.user.avatar)
    const name = useSelector((state:{user:UserState}) => state.user.name)
    const {id} = useParams()
    const [isLoading, setLoading] = useState(true)
    const [article, setArticle] = useState<NoteType|null>(null)

    useEffect(() => {
        if (id) {
            setLoading(true)
            getNoteById(id).then((res) => {
                setArticle({
                    ...res.data.data
                });
            }).catch((err) => {
                console.error('获取失败', err)
            }).finally(() => {
                setLoading(false)
            });
        }
        scrollToTop();
    }, [id]);
    
    const content = article?.noteContent || '';

    return (
        <div className='readContainer'>
            {isLoading ? (
                <div style={{width:'100vw',height:'100vh',display:'flex',justifyContent:'center',alignItems:'center'}}>
                    <Loading />
                </div>
            ) : (
                <>
                    <div className="readCover">
                        <motion.img
                            src={article?.cover}
                            initial={{ filter: "blur(10px)" }}
                            animate={{ filter: "blur(0px)" }}
                            transition={{ duration: 1 }}
                        />
                        <motion.div
                            initial={{ opacity: 0, x: -30 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ duration: 1 }}
                        >
                            <div className="readInfo">
                                <Flex gap={"small"} justify={"center"} align={"center"}>
                                    <Avatar src={avatar} size={40} className="frontAvatar" />
                                    {name}
                                </Flex>
                                <h1>{article?.noteTitle}</h1>
                                <h3>{dayjs(article?.updateTime).format("YYYY-MM-DD")}</h3>
                                <motion.div
                                    initial={{ scaleX: 0 }}
                                    animate={{ scaleX: 1 }}
                                    transition={{ duration: 1, delay: 0.5 }}
                                    style={{
                                        position:'absolute',
                                        bottom: -20,
                                        width: "100%",
                                        height: "2px",
                                        background: "#aec8c8",
                                        marginTop: "10px",
                                        transformOrigin: "left",
                                    }}
                                />
                            </div>
                        </motion.div>
                    </div>
                    <div className='readDescription'>
                        <span style={{color:'rgb(9,10,21)',fontSize:15,fontWeight:600,marginRight:10}}>内容概述:</span>
                        <p>{article?.description}</p>
                    </div>
                    <div className='readContent markdown-body'>
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 1 }}
                        >
                            {/* The markdown-body class is crucial for github-markdown-css */}
                            {/* We re-add it here on the wrapper */}
                            <div id="content" className="markdown-body">
                                <Viewer 
                                    value={content}
                                    plugins={plugins}
                                />
                            </div>
                        </motion.div>
                        <div className="navigation" id='toc'>
                             <MarkdownNavbar 
                                source={content} 
                                ordered={false} 
                                headingTopOffset={100}
                             />
                        </div>
                    </div>
                </>
            )}
        </div>
    )
}

export default ReadArticle
