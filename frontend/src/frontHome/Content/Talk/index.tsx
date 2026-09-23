import './index.sass'
import {useEffect, useState} from "react";
import {Avatar, Card, message} from "antd";
import {Talk} from "../../../interface/TalkType";
import {useSelector} from "react-redux";
import UserState from "../../../interface/UserState";
import { motion } from 'framer-motion';
import dayjs from "dayjs";
import scrollToTop from "../../../utils/scrollToTop.tsx";
import {getTalkList} from "../../../apis/TalkMethods.tsx";
import SeoHelmet from "../../../components/SeoHelmet";

const TalkList = () => {
    const [talkList,setTalkList] = useState<Talk[]>([])
    const avatar = useSelector((state:{user:UserState}) => state.user.avatar)
    useEffect(() => {
        scrollToTop(); // 初始化时滚动到顶部
        getTalkList().then((res) => {
            setTalkList(res.data.data)
        }).catch(()=>{
            message.error('获取失败')
        })
    }, [])

    return <div className='TalkContainer'>
        <SeoHelmet title="说说" url="/talk" />
        <h2>说说</h2>
        {talkList.map((talk:Talk,index) => {
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
                    在列表里长得一模一样，得看年份才知道是去年的还是今年的。 */}
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
                    <Card.Meta
                        avatar={<Avatar src={avatar} />}
                        title={talk.talkTitle}
                        description={talk.content}
                    />
                    {/* 卡片左下角：精确时刻（20260924 用户要求）。放秒是有意的——说说常连发，
                        同一天里几条的时间差就是"这条在回哪条"的线索。 */}
                    <div className='talk-foot'>
                        <span className='talk-clock'>{at.format('HH:mm:ss')}</span>
                    </div>
                </Card>
            </motion.div>
            )
        })}
    </div>
}

export default TalkList