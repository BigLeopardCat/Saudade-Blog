import './index.sass'
import beianIcon from '../../assets/备案图标.png'
import cfLogo from '../../assets/Cloudflare_Logo.svg'
import txLogo from '../../assets/Tencent_Cloud_logo.svg'
import bailianLogo from '../../assets/Bailian_Logo.svg'
import live2dLogo from '../../assets/Live2D_Cubism_Logo.png'
import {useEffect, useState} from "react";
import axios from "axios";
import {useSelector} from "react-redux";

const mpsCode = (s: string): string => (s.match(/\d{5,}/) || [''])[0]

const Footer = () => {
    const [onySay,setOnsay] = useState('')
    const blogIcp = useSelector((state:{user:{blogIcp: string}}) => state.user.blogIcp)
    const blogPublicIcp = useSelector((state:{user:{blogPublicIcp: string}}) => state.user.blogPublicIcp)
    const blogCopyright = useSelector((state:{user:{blogCopyright: string}}) => state.user.blogCopyright)
    const blogAuthor = useSelector((state:{user:{name: string}}) => state.user.name)
    const copyright = blogCopyright.trim() || blogAuthor.trim()
    const code = mpsCode(blogPublicIcp)
    useEffect(() => {
        const controller = new AbortController()
        axios.get('https://v1.jinrishici.com/all', {signal: controller.signal, timeout: 5000})
            .then(res => setOnsay(typeof res.data.content === 'string' ? res.data.content : ''))
            .catch(() => {})
        return () => controller.abort()
    }, []);
    return <>
        <footer className='footerContainer'>
            {copyright && (
                <p className="footLine">&copy; {new Date().getFullYear()} {copyright}</p>
            )}
            <p className="footNote">
                Powered by <a className="link" href="https://github.com/BigLeopardCat/Saudade-Blog" target="_blank" rel="noreferrer">Saudade Blog</a>
                {' · '}<span className="footTech footTechRust">Rust</span> &amp; <span className="footTech footTechAxum">Axum</span>
            </p>
            <p className="footNote">
                Based on <a className="link" href="https://github.com/LinMoQC/Memory-Blog" target="_blank" rel="noreferrer">Memory-Blog</a> by 林陌青川 (LinMo)
                {' · '}Maintained by Sora Saudade
            </p>
            {onySay && <em className="footPoem"><p>{onySay}</p></em>}
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