import {message, Tabs} from 'antd';
import type { TabsProps } from 'antd';
import "./index.sass"
import { Fab, TextField } from "@mui/material";
import Button from '@mui/material/Button';
import ArrowBackIosIcon from "@mui/icons-material/ArrowBackIos";
import React, {useEffect, useState} from "react";
import { webInfo } from "../../../interface/Setting";
import http from "../../../apis/axios.tsx";
import {useLocation, useNavigate} from "react-router-dom";
import GraphRebuild from "./GraphRebuild";
import R2Storage from "./R2Storage";

/**
 * 站点设置（/dashboard/usercontrol）。20260930 从四页签收成两页签：
 *
 *   · **「用户信息」整页签删除**——账号/密码/昵称/头像个人中心（`components/UserCenter`，
 *     首页头部「设置」入口）已经全覆盖，且账号本身就不可改。这里再留一份等于两个入口
 *     改同一份数据；更糟的是后端那条路**绕过登录页直接改 uid=1 的凭据**（那扇后门本轮已拆）。
 *     其中**个性签名**是唯一没有别处入口的字段，所以它**搬进了「站点信息」**。
 *   · **「其他设置」整页签删除**——OpenAI Token / Netease Cookies / Github Token 三个字段
 *     全仓只有"写"没有"读"（活早已被 agent 的 `.env` 取代），留着只是让人以为填了有用。
 *     另外「博客域名」「博客描述」两个同样从无消费方的字段也一并删掉。
 *
 * **本页只提交自己在管的这几个字段**（不是整份 webInfo 回传）：留言审核开关
 * （aiReviewEnabled/manualReviewEnabled）由后台「留言管理」页读写同一张 web_info 表，
 * 整份回传会把别的页面正在用的设置顺手覆盖掉。
 *
 * 剩下两个页签都是**真的有人读**的：站点信息喂页脚与首页署名，社交媒体喂首页那排按钮
 * （20260930 之前只有 Github 读设置，B 站/邮箱/QQ 三项是硬编码——那正是隐私泄漏的源头）。
 *
 * 20261003 加了第三个页签「向量图谱」（`./GraphRebuild`）：按用户的原话，手动重算图谱的
 * 入口就放在这里，不新开侧边栏——侧边栏那一格的索引（8）已被本页占用，动它要连带改
 * `HASH_INDEX` 与所有书签。它不是"设置"，而是**本页本来就是"站点自己的东西怎么配"** 的去处。
 *
 * 20261006 加了第四个页签「图库存储」（`./R2Storage`，用户第 3 条）。三条理由压在一起：
 *   · 用户拍板「挪到站点设置，单一入口」——图库那边从此只留用量与灰态，不再有配置表单；
 *   · 与「向量图谱」同属"站点自己的东西怎么配"，语义就是本页；
 *   · **凭据不在这里**（只从服务端 .env 读）。⚠️ 但也**别把本页当保险箱**：
 *     `GET /api/protected/websetting` 会把每一行**明文回传**给面板，而那道门是
 *     `authz::can_access_console`（admin ‖ superadmin）——"站点设置只有超管能打开"
 *     这件事今天并不成立（本页自己的路门 `AuthRouter` 用的也是 `isAdminToken`）。
 *     凡是不能明文回传的东西，就不该进 `web_info`（同 `openAiToken` 被删的理由）。
 */
const EMPTY: webInfo = {
    blogTitle: '',
    blogAuthor: '',
    blogIcp: '',
    blogPublicIcp: '',
    blogCopyright: '',
    userTalk: '',
    socialGithub: '',
    socialBilibili: '',
    socialEmail: '',
    socialQQ: '',
};

const UserControl = () => {
    const navigate = useNavigate()
    // 落在哪个页签，默认第一个。图库页那颗「R2 存储 · N%」按钮带 `{tab:'4'}` 跳过来——
    // 少了这一步，用户点"设置"却落在「站点信息」上，读起来就像那颗按钮没干它说的事。
    // 只影响首次挂载（`defaultActiveKey` 是非受控的），之后随用户点。
    const initialTab = ((useLocation().state as { tab?: string } | null)?.tab) ?? '1'
    const [webInfo, setWebInfo] = useState<webInfo>(EMPTY);

    useEffect(() => {
        getSetting()
    }, []);


    const getSetting = () => {
        http({
            url: '/api/protected/websetting',
            method: 'GET'
        }).then((res) => {
            if(res.status === 200 && res.data?.code === 200){
                const d = res.data.data || {}
                // 后端这些字段是 `Option<String>`，没配过就是 **null**（不是空串）。
                // 直接把 null 塞进 MUI TextField 的 value 会退成非受控并警告一片，
                // 所以逐字段过一道"不是字符串就当没填"。
                const pick = (k: keyof webInfo) => (typeof d[k] === 'string' ? d[k] : '')
                setWebInfo({
                    blogTitle: pick('blogTitle'),
                    blogAuthor: pick('blogAuthor'),
                    blogIcp: pick('blogIcp'),
                    blogPublicIcp: pick('blogPublicIcp'),
                    blogCopyright: pick('blogCopyright'),
                    userTalk: pick('userTalk'),
                    socialGithub: pick('socialGithub'),
                    socialBilibili: pick('socialBilibili'),
                    socialEmail: pick('socialEmail'),
                    socialQQ: pick('socialQQ'),
                })
            }
        })
    }

    const comeBack = () => {
        navigate(-1)
    }

    const handleChange = (event: { target: { id: string; value: string; }; }) => {
        const { id, value } = event.target;
        setWebInfo({ ...webInfo, [id]: value });
    };


    const handleSubmit: React.FormEventHandler<HTMLFormElement> | undefined = (e: { preventDefault: () => void; }) => {
        e.preventDefault();
        http({
            url: '/api/protected/websetting',
            method: 'POST',
            data: webInfo
        }).then((res) => {
            if(res.status === 200 && res.data?.code === 200){
                getSetting()
                message.success("保存成功")
            } else {
                message.error(res.data?.message || "保存失败")
            }
        })
    }

    /** 每个输入框的属性基本一样，抽一处——两页签十几个字段，各写一遍必然漂移。
     *  `hint` 给"这一项在链路上不是唯一来源"的字段用（目前只有博客作者）：把优先级
     *  写在字段下面，免得改完没生效时以为是 bug——**字段还在、只是被更靠前的来源盖住**，
     *  这正是本仓最恨的那种"看起来是死配置"的坑。 */
    const field = (id: keyof webInfo, label: string, extra?: { multiline?: boolean; hint?: string }) => (
        <TextField
            key={id}
            id={id}
            label={label}
            variant="outlined"
            size='medium'
            color='primary'
            focused
            multiline={extra?.multiline}
            rows={extra?.multiline ? 3 : undefined}
            // `uc-70` 只为窄屏那条媒体规则当抓手（宽度是内联的，普通声明够不着）
            className='uc-70'
            style={{ width: '70%', marginBottom: 20 }}
            onChange={handleChange}
            value={webInfo[id]}
            helperText={extra?.hint}
        />
    )

    const items: TabsProps['items'] = [
        {
            key: '1',
            label: <h3>站点信息</h3>,
            children: <>
                <form className='web_setting' onSubmit={handleSubmit}>
                    {field('blogTitle', '博客标题')}
                    {/* 署名优先用个人中心的昵称（20260930）：这一项是**回退值**，
                        昵称非空时它不参与显示。不写在这会让"改完没反应"看起来像 bug。 */}
                    {field('blogAuthor', '博客作者', { hint: '署名优先取个人中心的昵称；昵称为空时才用这里' })}
                    {field('userTalk', '个性签名')}
                    {field('blogIcp', 'ICP 备案号')}
                    {field('blogPublicIcp', '公安网安备案号')}
                    {field('blogCopyright', '版权署名')}
                    <div className='uc-70' style={{ justifyContent: 'flex-end', display: 'flex', width: '70%' }}>
                        <Button variant="contained" style={{ width: 100 }} type='submit'>保存</Button>
                    </div>
                </form>
            </>,
        },
        {
            key: '2',
            label: <h3>社交媒体</h3>,
            children: <>
                <form className='web_setting' onSubmit={handleSubmit}>
                    {field('socialGithub', 'Github')}
                    {field('socialBilibili', 'Bilibili')}
                    {field('socialEmail', 'Email')}
                    {field('socialQQ', 'QQ')}
                    <div className='uc-70' style={{ justifyContent: 'flex-end', display: 'flex', width: '70%' }}>
                        <Button variant="contained" style={{ width: 100 }} type='submit'>保存</Button>
                    </div>
                </form>
            </>,
        },
        {
            key: '3',
            label: <h3>向量图谱</h3>,
            // 不属于 webInfo 那套表单：它不写设置，而是起一个后台任务（见 GraphRebuild 头注）
            children: <GraphRebuild />,
        },
        {
            key: '4',
            label: <h3>图库存储</h3>,
            // 同样不属于 webInfo 那套表单：它只提交 R2 那五个键（见 R2Storage 头注）。
            // 图库页那颗「R2 存储 · N%」按钮会带着 `{tab:'4'}` 跳到这里。
            children: <R2Storage />,
        },
    ];

    // 内联 style 搬进 index.sass 的 `.allin`（20261004）：原来只有 `padding` 与
    // `overflowY:'scroll'`，**没有高度** ⇒ 块级自动高度让那行 overflow 从未生效，
    // 整页超出的部分被 `.Card{overflow:hidden}` 裁掉且无处可滚。高度写在类里。
    return (
        <div className='allin'>
            <Fab variant="circular" size='small' style={{ position: 'absolute', cursor: 'pointer' }} onClick={comeBack}>
                <ArrowBackIosIcon fontSize='small' style={{cursor:'pointer'}}/>
            </Fab>
            <Tabs defaultActiveKey={initialTab} items={items} centered={true} />
        </div>
    );
}

export default UserControl;
