import './index.sass'
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
            <p>Copyright © 2024 林陌青川 (LinMo). All rights reserved.</p>
            <p style={{ marginTop: 5, fontSize: '0.9em', opacity: 0.8, textAlign: 'center', width: '100%' }}>Based on work refactored, extended and optimized with <span style={{ fontWeight: 'bold', color: '#dea584' }}>Rust</span> &amp; <span style={{ fontWeight: 'bold', color: '#667ea5' }}>Axum</span>.</p>
            <p style={{ marginTop: 5, fontSize: '0.9em', opacity: 0.8, textAlign: 'center', width: '100%' }}>Copyright &copy; 2026 Sora Saudade.</p>
            <em><p style={{marginTop: 10}}>{onySay}</p></em>
            <p style={{marginTop:10,marginBottom:10}}><a className="link" target="_blank" rel="noreferrer" href="https://beian.miit.gov.cn/">{blogIcp}</a></p>
            <p>Powered by <span>Memory</span></p>
        </footer>
    </>
}

export default Footer