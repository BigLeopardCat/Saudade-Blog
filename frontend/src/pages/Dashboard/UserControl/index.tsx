import {message, Tabs} from 'antd';
import type { TabsProps } from 'antd';
import "./index.sass"
import { Fab, TextField } from "@mui/material";
import Button from '@mui/material/Button';
import ArrowBackIosIconDefault from "@mui/icons-material/ArrowBackIos";
import React, {useEffect, useState} from "react";
import { webInfo } from "../../../interface/Setting";
import http from "../../../apis/axios.tsx";
import {useLocation, useNavigate} from "react-router-dom";
import R2Storage from "./R2Storage";
import {cjsDefault} from "../../../utils/cjsDefault";

// @mui 的图标包是 CJS，Vite 8 之后默认 import 拿到的是名字空间对象而不是组件
// （这一页就是 `/dashboard/usercontrol` 整页 `Unexpected Application Error! React #130`
//  的来源）。判据与三种形态见 utils/cjsDefault.ts。**不要改回裸的 default import。**
const ArrowBackIosIcon = cjsDefault(ArrowBackIosIconDefault)

/** 站点身份、社交链接和图库存储的配置入口。 */
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
