import './index.sass'
import {useCallback, useEffect, useState} from "react";
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

    return <div className='TalkContainer'>
        <SeoHelmet title="说说" url="/talk" />
        <h2>说说</h2>
        {loadFailed && <div className='talkEmpty'>
            <span>说说没能读取出来，请稍后再试</span>
            <button type='button' className='talkRetry' onClick={load}>重试</button>
        </div>}
        {!loadFailed && talkList.length === 0 && <div className='talkEmpty'>还没有说说</div>}
        {!loadFailed && talkList.map((talk:Talk,index) => {
            // 一次解析、三处用（链条的年份、链条的月日、卡片左下角的时分秒）——
            // 后端给的是 "YYYY-MM-DD HH:MM:SS" 本地钟面字符串，dayjs 直接可解。
            const at = dayjs(talk.createTime)
            return (
            <motion.div
            key={index}
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: index * 0.2 ,ease: "linear"}}
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
                    key={talk.talkKey}
                    hoverable
                    style={{ width: 700, marginTop: 25 ,fontWeight:600}}
                    className='talk'
                >
                    {/* 头像必须是**这条说说的发布者**的，不是看的人自己的（20261005 修）。
                        原来这里是 `state.user.avatar`（当前登录用户的头像）：未登录时它
                        是空串 ⇒ 每张卡都是个空头像；登录了则每条都显示自己的脸。后端现在
                        在 `src=talk` 的列表里带上 `nickname`/`avatar`（`user_id` 那一行的
                        真实账号，取不到用户行时后端兜 `用户#<id>`）。 */}
                    <Card.Meta
                        avatar={<Avatar src={talk.avatar || undefined} />}
                        title={talk.talkTitle}
                        description={talk.content}
                    />
                    {/* 卡片右下角：精确时刻（20260924 用户要求；三轮起从左下角挪到右下角，
                        它上面那条虚线也撤了——主人原话"不要占用这么高的分割线"）。
                        放秒是有意的：说说常连发，同一天里几条的时间差就是"这条在回哪条"的线索。
                        20261005 起左边补上发布者展示名（讨论区那种"谁发的"）。 */}
                    <div className='talk-foot'>
                        <span className='talk-who'>{talk.nickname}</span>
                        <span className='talk-clock'>{at.format('HH:mm:ss')}</span>
                    </div>
                </Card>
            </motion.div>
            )
        })}
    </div>
}

export default TalkList
