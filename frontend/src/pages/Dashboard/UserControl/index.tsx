import {message, Tabs} from 'antd';
import type { TabsProps } from 'antd';
import "./index.sass"
import { Fab, TextField } from "@mui/material";
import Button from '@mui/material/Button';
import ArrowBackIosIcon from "@mui/icons-material/ArrowBackIos";
import React, {useEffect, useState} from "react";
import { webInfo } from "../../../interface/Setting";
import http from "../../../apis/axios.tsx";
import {useNavigate} from "react-router-dom";

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

    /** 每个输入框的属性基本一样，抽一处——两页签十几个字段，各写一遍必然漂移 */
    const field = (id: keyof webInfo, label: string, extra?: { multiline?: boolean }) => (
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
            style={{ width: '70%', marginBottom: 20 }}
            onChange={handleChange}
            value={webInfo[id]}
        />
    )

    const items: TabsProps['items'] = [
        {
            key: '1',
            label: <h3>站点信息</h3>,
            children: <>
                <form className='web_setting' onSubmit={handleSubmit}>
                    {field('blogTitle', '博客标题')}
                    {field('blogAuthor', '博客作者')}
                    {field('userTalk', '个性签名')}
                    {field('blogIcp', 'ICP 备案号')}
                    {field('blogPublicIcp', '公安网安备案号')}
                    {field('blogCopyright', '版权署名')}
                    <div style={{ justifyContent: 'flex-end', display: 'flex', width: '70%' }}>
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
                    <div style={{ justifyContent: 'flex-end', display: 'flex', width: '70%' }}>
                        <Button variant="contained" style={{ width: 100 }} type='submit'>保存</Button>
                    </div>
                </form>
            </>,
        },
    ];

    return (
        <div style={{ padding: 20,overflowY:'scroll' }} className='allin'>
            <Fab variant="circular" size='small' style={{ position: 'absolute', cursor: 'pointer' }} onClick={comeBack}>
                <ArrowBackIosIcon fontSize='small' style={{cursor:'pointer'}}/>
            </Fab>
            <Tabs defaultActiveKey="1" items={items} centered={true} />
        </div>
    );
}

export default UserControl;
