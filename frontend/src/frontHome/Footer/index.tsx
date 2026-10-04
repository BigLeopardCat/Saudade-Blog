import './index.sass'
import beianIcon from '../../assets/备案图标.png'
import cfLogo from '../../assets/Cloudflare_Logo.svg'
import txLogo from '../../assets/Tencent_Cloud_logo.svg'
// 20261001 开源前准备：这两个 logo 原先一个走 img.alicdn.com、一个走 live2d.com ——
// 前者是**别人账号下**的图片（换了/删了这里就是个破图），后者是外站热链（对方改路径
// 或加防盗链同样破图），两种都是"别人部署就异常"的来源。与上面 Tencent/Cloudflare
// 两个一样收进 `src/assets/`，由 Vite 打包。尺寸由 `.footLogoAli` / `.footLogoLive2d`
// 钉死（112×24 / 96×24），与两张图各自的原始宽高比一致，换源不动排版。
import bailianLogo from '../../assets/Bailian_Logo.svg'
import live2dLogo from '../../assets/Live2D_Cubism_Logo.png'
import {useEffect, useState} from "react";
import axios from "axios";
import {useSelector} from "react-redux";

/**
 * 公安网安备案号里的数字 code（网安查询链接要它）。
 * **从展示串里现抽，不另存一份**——两处各存一份迟早对不上：改了备案号却忘了改链接，
 * 点进去查到的是别人的站。形如「鲁公网安备37048102006993号」⇒ 37048102006993。
 */
const mpsCode = (s: string): string => (s.match(/\d{5,}/) || [''])[0]

const Footer = () => {
    const [onySay,setOnsay] = useState('')
    const blogIcp = useSelector((state:{user:{blogIcp: string}}) => state.user.blogIcp)
    // 公安网安备案号与版权署名（20260930）：都是**部署者自己的身份信息**，
    // 以前写死在源码里 —— 仓库一公开，别人 fork 就直接顶着你的备案号与真名上线。
    const blogPublicIcp = useSelector((state:{user:{blogPublicIcp: string}}) => state.user.blogPublicIcp)
    const blogCopyright = useSelector((state:{user:{blogCopyright: string}}) => state.user.blogCopyright)
    const blogAuthor = useSelector((state:{user:{name: string}}) => state.user.name)
    // 署名总得有，但"具体写谁"归部署者 —— 没单独填就回退到博客作者。
    const copyright = blogCopyright || blogAuthor
    const code = mpsCode(blogPublicIcp)
    useEffect(() => {
        axios.get('https://v1.jinrishici.com/all').then((res) => {
            setOnsay(res.data.content)
        })
    }, []);
    return <>
        <footer className='footerContainer'>
            {/* ⚠️ 页脚这两行是**两种不同身份**，别再合成一行，也别互相替换：
                ① **来源链**（`.footLine`，静态、硬编码，对任何部署者都一样）——回答"这个站点建在
                   谁的工作之上"。上游是 github.com/LinMoQC/Memory-Blog（GPL-2.0），Rust 这一支
                   是本站重写的。这两件事是**历史事实**：别人 fork 走部署，这一行**照样是他该显示的**
                   （GPL 也要求保留上游署名），**不许换成部署者自己的名字**。
                ② **本站部署者**（`.footNote`，动态，取自后台设置 `blogCopyright`，没填回退到
                   `blogAuthor`）——别人拿去部署时**不用改代码**，在后台填自己的名字即可，
                   这一行会自动变成他的。这是本仓的既定口径：**部署者身份一律走设置，
                   源码里不许出现部署者身份**（备案号 blogIcp / blogPublicIcp 同理，见 :26-28）。
                两点容易踩：
                · 上游那行**不写 "Copyright … All rights reserved."** —— 它只是署名，不是本站的
                  许可声明。本仓库以 GPL-2.0 分发（见 LICENSE／README §许可），"保留所有权利"
                  与 GPL 授予的复制/修改/再分发权相抵；真要说许可，指向 LICENSE，别在页脚写。
                · 年份**取当前年**、不写死：写死的那一版（`© 2026`）过一年就成了陈年话。 */}
            {/* ⚠️ 全页脚**零行内样式**（20261001 第 4 条这轮清掉的）：这一片的颜色、字号、
                间距原来全写在 `style={{…}}` 里，而内联特异性最高 —— 主题令牌压不动它，
                换夜间/换配色只能 `!important` 硬压。形状归 `Footer/index.sass`，
                分段配色归 `src/index.css` 的 `--band-foot*`。**别再加回来。** */}
            {/* 上游署名那一句 20261005 前的原文是
                「Based on work refactored, extended and optimized with Rust & Axum.」——
                没有施事主语（Rust 重写是谁做的读不出来），那是 2026-06-16 把
                「…Optimized **by Sora Saudade** (2026)」改成「…**with** Rust & Axum」时丢的。
                现在拆成两句、各自带主语：第一句说"基于谁"，第二句说"谁重写的"。 */}
            <p className="footLine">Based on Memory-Blog by 林陌青川 (LinMo). Refactored, extended and optimized in <span className="footTech footTechRust">Rust</span> &amp; <span className="footTech footTechAxum">Axum</span> by Sora Saudade.</p>
            {copyright && (
                <p className="footNote">Copyright &copy; {new Date().getFullYear()} {copyright}.</p>
            )}
            <em className="footPoem"><p>{onySay}</p></em>
            {/* 两个备案号**各自独立渲染**：只有 ICP 的站很多，只有网安备案的几乎没有，
                但它们中间那根 "|" 和图标是按"两个都有"排的 —— 只填一个时会出现悬空竖线。
                两个都空 ⇒ 整块不渲染（取舍与首页社媒按钮一致：宁可没有，也不要假的）。 */}
            {(blogIcp || blogPublicIcp) && (
                <p className="footBeian">
                    {blogIcp && (
                        <a className="link" target="_blank" rel="noreferrer" href="https://beian.miit.gov.cn/">{blogIcp}</a>
                    )}
                    {blogIcp && blogPublicIcp && ' | '}
                    {blogPublicIcp && (<>
                        <img className="footBeianIcon" src={beianIcon} alt="" />
                        {code
                            ? <a className="link" href={`https://beian.mps.gov.cn/#/query/webSearch?code=${code}`} rel="noreferrer" target="_blank">{blogPublicIcp}</a>
                            // 抽不出数字就别做成链接 —— 链到 `?code=` 空参的查询页比不链更糟
                            : <span>{blogPublicIcp}</span>}
                    </>)}
                </p>
            )}
            {/* 20260930 删掉「Powered by Memory」那行（用户点名）：它是上游脚手架自带的署名行，
                与上面两条版权声明重复，读起来像"本站是某个叫 Memory 的工具生成的"。 */}
            <p className="footLogos">
                <a href="https://www.aliyun.com/product/bailian" target="_blank" rel="noreferrer" title="阿里云百炼">
                    <img className="footLogoAli" src={bailianLogo} alt="阿里云百炼" />
                </a>
                <a href="https://cloud.tencent.com" target="_blank" rel="noreferrer" title="Tencent Cloud">
                    <img className="footLogoTx" src={txLogo} alt="Tencent Cloud" />
                </a>
                <a href="https://www.cloudflare.com" target="_blank" rel="noreferrer" title="Cloudflare">
                    <img className="footLogoCf" src={cfLogo} alt="Cloudflare" />
                </a>
                <a href="https://www.live2d.com/zh-CHS/" target="_blank" rel="noreferrer" title="Live2D Cubism">
                    <img className="footLogoLive2d" src={live2dLogo} alt="Live2D Cubism" />
                </a>
            </p>
        </footer>
    </>
}

export default Footer