import './index.sass'
import beianIcon from '../../assets/备案图标.png'
import cfLogo from '../../assets/Cloudflare_Logo.svg'
import txLogo from '../../assets/Tencent_Cloud_logo.svg'
import {useEffect, useState} from "react";
import axios from "axios";
import {useSelector} from "react-redux";

const Footer = () => {
    const [onySay,setOnsay] = useState('')
    const blogIcp = useSelector((state:{user:{blogIcp: string}}) => state.user.blogIcp)
    useEffect(() => {
        axios.get('https://v1.jinrishici.com/all').then((res) => {
            setOnsay(res.data.content)
        })
    }, []);
    return <>
        <footer className='footerContainer'>
            <p style={{ textAlign: "center", width: "100%" }}>Copyright © 2024 林陌青川 (LinMo). All rights reserved.</p>
            <p style={{ marginTop: 5, fontSize: '0.9em', opacity: 0.8, textAlign: 'center', width: '100%' }}>Based on work refactored, extended and optimized with <span style={{ fontWeight: 'bold', color: '#dea584' }}>Rust</span> &amp; <span style={{ fontWeight: 'bold', color: '#667ea5' }}>Axum</span>.</p>
            <p style={{ marginTop: 5, fontSize: '0.9em', opacity: 0.8, textAlign: 'center', width: '100%' }}>Copyright &copy; 2026 Sora Saudade.</p>
            <em><p style={{marginTop: 10}}>{onySay}</p></em>
            <p style={{marginTop:10,marginBottom:10,textAlign:"center"}}><a className="link" target="_blank" rel="noreferrer" href="https://beian.miit.gov.cn/">{blogIcp}</a> | <img src={beianIcon} style={{width:16,height:16,verticalAlign:"middle",marginRight:4}} /><a className="link" href="https://beian.mps.gov.cn/#/query/webSearch?code=37048102006993" rel="noreferrer" target="_blank">鲁公网安备37048102006993号</a></p>
            <p>Powered by <span>Memory</span></p>
            <p style={{marginTop:8,fontSize:'0.8em',opacity:0.6,textAlign:'center',display:'flex',justifyContent:'center',gap:12,alignItems:'center'}}>
                <a href="https://cloud.tencent.com" target="_blank" rel="noreferrer" title="Tencent Cloud">
                    <img src={txLogo} style={{width:26,height:26}} />
                </a>
                <a href="https://www.cloudflare.com" target="_blank" rel="noreferrer" title="Cloudflare">
                    <img src={cfLogo} style={{width:26,height:26}} />
                </a>
            </p>
        </footer>
    </>
}

export default Footer