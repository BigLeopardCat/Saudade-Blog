import './index.sass'
import beianIcon from '../../assets/备案图标.png'
import cfLogo from '../../assets/Cloudflare_Logo.svg'
import txLogo from '../../assets/Tencent_Cloud_logo.svg'
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
            {/* 这一行是**上游开源项目**（github.com/LinMoQC/Memory-Blog，GPL-2.0）的作者署名，
                不是本站部署者的身份信息 —— 它本来就公开在上游仓库与 README 里，照原样保留。
                由本站部署者自己署名的是下面那一行（`copyright` 设置）。 */}
            <p style={{ textAlign: "center", width: "100%" }}>Copyright © 2024 林陌青川 (LinMo). All rights reserved.</p>
            <p style={{ marginTop: 5, fontSize: '0.9em', opacity: 0.8, textAlign: 'center', width: '100%' }}>Based on work refactored, extended and optimized with <span style={{ fontWeight: 'bold', color: '#dea584' }}>Rust</span> &amp; <span style={{ fontWeight: 'bold', color: '#667ea5' }}>Axum</span>.</p>
            {copyright && (
                <p style={{ marginTop: 5, fontSize: '0.9em', opacity: 0.8, textAlign: 'center', width: '100%' }}>Copyright &copy; 2026 {copyright}.</p>
            )}
            <em><p style={{marginTop: 10}}>{onySay}</p></em>
            {/* 两个备案号**各自独立渲染**：只有 ICP 的站很多，只有网安备案的几乎没有，
                但它们中间那根 "|" 和图标是按"两个都有"排的 —— 只填一个时会出现悬空竖线。
                两个都空 ⇒ 整块不渲染（取舍与首页社媒按钮一致：宁可没有，也不要假的）。 */}
            {(blogIcp || blogPublicIcp) && (
                <p style={{marginTop:10,marginBottom:10,textAlign:"center"}}>
                    {blogIcp && (
                        <a className="link" target="_blank" rel="noreferrer" href="https://beian.miit.gov.cn/">{blogIcp}</a>
                    )}
                    {blogIcp && blogPublicIcp && ' | '}
                    {blogPublicIcp && (<>
                        <img src={beianIcon} style={{width:16,height:16,verticalAlign:"middle",marginRight:4}} />
                        {code
                            ? <a className="link" href={`https://beian.mps.gov.cn/#/query/webSearch?code=${code}`} rel="noreferrer" target="_blank">{blogPublicIcp}</a>
                            // 抽不出数字就别做成链接 —— 链到 `?code=` 空参的查询页比不链更糟
                            : <span>{blogPublicIcp}</span>}
                    </>)}
                </p>
            )}
            {/* 20260930 删掉「Powered by Memory」那行（用户点名）：它是上游脚手架自带的署名行，
                与上面两条版权声明重复，读起来像"本站是某个叫 Memory 的工具生成的"。 */}
            <p style={{marginTop:8,fontSize:'0.8em',opacity:0.6,textAlign:'center',display:'flex',justifyContent:'center',gap:12,alignItems:'center'}}>
                <a href="https://www.aliyun.com/product/bailian" target="_blank" rel="noreferrer" title="阿里云百炼">
                    <img src="https://img.alicdn.com/imgextra/i1/O1CN01IU2US71Ciicsi3Br3_!!6000000000115-55-tps-357-76.svg" style={{width:70,height:70}} />
                </a>
                <a href="https://cloud.tencent.com" target="_blank" rel="noreferrer" title="Tencent Cloud">
                    <img src={txLogo} style={{width:50,height:50}} />
                </a>
                <a href="https://www.cloudflare.com" target="_blank" rel="noreferrer" title="Cloudflare">
                    <img src={cfLogo} style={{width:50,height:50}} />
                </a>
                <a href="https://www.live2d.com/zh-CHS/" target="_blank" rel="noreferrer" title="Live2D Cubism">
                    <img src="https://www.live2d.com/wp-content/themes/cubism_new/assets/img/cubism-logo.png" style={{width:60,height:15}} />
                </a>
            </p>
        </footer>
    </>
}

export default Footer