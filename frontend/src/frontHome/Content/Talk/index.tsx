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
    // 读失败与"确实一条都没有"必须分开（20261005）。原来只有 `.catch`：接口回
    // `code=500`（data 是空数组）时走的是 `.then`，列表被设成 []——页面变成一片空白，
    // 与"站内还没发过说说"长得一模一样。这是本仓"读不到 ≠ 没有"那条纪律的又一处落点。
    const [loadFailed,setLoadFailed] = useState(false)
    /** 已经定位过的 tk（**记的是值不是布尔**：同页再点另一条说说时要能重新定位） */
    const locatedRef = useRef<number | null>(null)
    /* 深链 `?tk=<talk id>`（20261006）：站内聚合搜索的一条说说点进来时定位到它。
     *
     * ⚠️ **必须是响应式的 `useSearchParams`，不能是"挂载时读一次地址栏"**（留言板那份
     * `/guestbook?lid=` 就是那么写的）：`/talk → /talk?tk=5` 是**同一条路由**，React Router
     * 不会重挂载本组件——挂载时读一次的实现只在"从别的页面跳进来"时有效，用户已经站在
     * `/talk` 上再点一条说说会**静默不定位**（与 `CommentSection` 的 `?cid=` 同一处坑）。 */
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

    /* 深链定位（`?tk=`）：列表到位后滚到那一条并闪一下高亮。**与 `CommentSection` 的
     * `?cid=` 同一套做法**（那边踩过的坑这里一个都不少）：
     *
     * · **必须等 `talkList` 到位**——那一行是渲染出来的，DOM 里还没有就 `getElementById` 不到。
     * · **瞬时滚动 + double-rAF 重放**，不用 `behavior: 'smooth'`：本页挂载时会
     *   `scrollToTop()`，而那是**平滑**滚动——列表回来时它可能还在动画里，随后的平滑定位
     *   会被顶掉或与之拉扯，症状就是"点进来停在页面顶部"。瞬时滚动会取消在途的平滑动画，
     *   double-rAF 再补一次压过同帧的其它滚动。
     * · **目标不在列表里就安静兜底**：说明这条说说已被删/被驳回，而页面本身已经开在说说
     *   列表上了，再弹一句"没找到"只会添乱（同 `CommentSection` 与留言板）。
     * · **不写 cleanup**：摘掉高亮由那个 1.8s 定时器负责，若放进 cleanup，一次无关的重渲染
     *   就会把还没闪完的高亮掐掉。
     */
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
                {/* 日期链条：20260924 起带上年份（原来是只有 MM.DD 的单行）——跨年的说说
                    在列表里长得一模一样，得看年份才知道是去年的还是今年的。
                    年份在月日**前面**、同一行（原来是年份一行压在月日上面）。 */}
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
                    {/* 头像必须是**这条说说的发布者**的，不是看的人自己的（20261005 修）。
                        原来这里是 `state.user.avatar`（当前登录用户的头像）：未登录时它
                        是空串 ⇒ 每张卡都是个空头像；登录了则每条都显示自己的脸。后端现在
                        在 `src=talk` 的列表里带上 `nickname`/`avatar`（`user_id` 那一行的
                        真实账号，取不到用户行时后端兜 `用户#<id>`）。 */}
                    {/* 20261006 用户第 4 条：署名挪到**头像右侧同一行**、标题另起一行。
                        三行**全部**放进 `description`，`Card.Meta` 的 `title` 槽弃用 ——
                        不是为了省事，是因为本文件的 `.ant-card-meta-title` 有一条
                        `color: var(--font-title-color) !important`，署名进了那个槽会被
                        染成标题色，压回去就得再堆一条 !important（而 antd 在没有 title
                        时**不渲染**那个 div，见 `card/Meta.js`：`title ? <div …/> : null`
                        —— 所以留空槽不会多出一个缝）。
                        顺带把时刻从卡片底部提到这一行（用户按预览拍的板），
                        `.talk-foot` 那一行整块撤掉。 */}
                    <Card.Meta
                        avatar={<Avatar src={talk.avatar || undefined} />}
                        description={<>
                            {/* 第一行：署名（左）＋精确时刻（右）。
                                时刻放秒是有意的：说说常连发，同一天里几条的时间差就是
                                "这条在回哪条"的线索（20260924 用户要求，原在左下角）。 */}
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
