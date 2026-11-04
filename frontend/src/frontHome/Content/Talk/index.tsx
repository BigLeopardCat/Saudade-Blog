import './index.sass'
import {useCallback, useEffect, useRef, useState} from "react";
import {useSearchParams} from "react-router-dom";
import {Avatar, Card, message} from "antd";
import {Talk} from "../../../interface/TalkType";
import { motion } from 'framer-motion';
import dayjs from "dayjs";
import scrollToTop from "../../../utils/scrollToTop.tsx";
import {getTalkList} from "../../../apis/TalkMethods.tsx";
import SeoHelmet from "../../../components/SeoHelmet";

const TalkList = () => {
    const [talkList,setTalkList] = useState<Talk[]>([])
    const [loadFailed,setLoadFailed] = useState(false)
    /** 已经定位过的 tk（**记的是值不是布尔**：同页再点另一条说说时要能重新定位） */
    const locatedRef = useRef<number | null>(null)
    const [searchParams] = useSearchParams()
    const tk = Number(searchParams.get('tk')) || 0

    const load = useCallback(() => {
        setLoadFailed(false)
        getTalkList().then((res) => {
            if (res.data.code !== 200) {
                setLoadFailed(true)
                return
            }
            setTalkList(res.data.data)
        }).catch(()=>{
            setLoadFailed(true)
            message.error('获取失败')
        })
    },[])

    useEffect(() => {
        scrollToTop(); // 初始化时滚动到顶部
        load()
    }, [load])

    useEffect(() => {
        if (!tk || talkList.length === 0 || locatedRef.current === tk) return
        const el = document.getElementById(`t-${tk}`)
        if (!el) return
        locatedRef.current = tk
        const jump = () => el.scrollIntoView({ block: 'center', behavior: 'auto' })
        requestAnimationFrame(() => {
            jump()
            requestAnimationFrame(jump)
        })
        el.classList.add('talk-hit')
        window.setTimeout(() => el.classList.remove('talk-hit'), 1800)
    }, [tk, talkList])

    return <div className='TalkContainer'>
        <SeoHelmet title="说说" url="/talk" />
        <h2>说说</h2>
        {loadFailed && <div className='talkEmpty'>
            <span>说说没能读取出来，请稍后再试</span>
            <button type='button' className='talkRetry' onClick={load}>重试</button>
        </div>}
        {!loadFailed && talkList.length === 0 && <div className='talkEmpty'>还没有说说</div>}
        {!loadFailed && talkList.map((talk:Talk,index) => {
            // 一次解析、三处用（链条的年份、链条的月日、卡片首行的时分秒）——
            // 后端给的是 "YYYY-MM-DD HH:MM:SS" 本地钟面字符串，dayjs 直接可解。
            const at = dayjs(talk.createTime)
            return (
            <motion.div
            // 用 `talkKey` 而不是数组下标：下标当 key 时列表一变（有一条被删/新发一条）
            // 后面的卡片会整片错位复用。深链定位也要这个 key 稳定。
            key={talk.talkKey}
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            // 入场错峰（每张往后 0.2s）。**带 `tk` 时压成 0**：深链落到第二十条时那张卡
            // 按 index*0.2 要等 4 秒才铺开，而 `scrollIntoView` 量到的是**位移中**的盒子。
            transition={{ duration: 0.5, delay: tk ? 0 : index * 0.2 ,ease: "linear"}}
            className="article"
            style={{position:'relative'}}
        >
                <h3 className='talkTime'>
                    <span className='talkTime-year'>{at.format('YYYY')}</span>
                    <span className='talkTime-day'>{at.format('MM.DD')}</span>
                </h3>
                <Card
                    // 深链锚点。**放在 Card 上、不放外层 `motion.div` 上**：外层那个元素
                    // 带着 framer-motion 的入场位移（`y: -20 → 0`，走 transform），锚点挂上去
                    // `scrollIntoView` 量到的是**位移中**的盒子（同"错峰延迟"那条的理由）。
                    // antd 的 Card 会把 `id` 透传到根 div 上（`Card.js` 的 `divProps` 就是 `...others`）。
                    id={`t-${talk.talkKey}`}
                    hoverable
                    style={{ width: 700, marginTop: 25 ,fontWeight:600}}
                    className='talk'
                >
                    <Card.Meta
                        avatar={<Avatar src={talk.avatar || undefined} />}
                        description={<>
                            <div className='talk-head'>
                                <span className='talk-who'>{talk.nickname}</span>
                                <span className='talk-clock'>{at.format('HH:mm:ss')}</span>
                            </div>
                            <div className='talk-title'>{talk.talkTitle}</div>
                            <div className='talk-content'>{talk.content}</div>
                        </>}
                    />
                </Card>
            </motion.div>
            )
        })}
    </div>
}

export default TalkList
