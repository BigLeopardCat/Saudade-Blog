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
            <p>©2024 林陌青川 | LinMo</p>
            <p style={{ marginTop: 5, fontSize: '0.9em', opacity: 0.8, textAlign: 'center', width: '100%' }}><span style={{ fontWeight: 'bold', color: '#dea584' }}>Rust</span> & <span style={{ fontWeight: 'bold', color: '#8ca3ca' }}>Axum</span> Refactored, Extended & Optimized by Sora Saudade (2026)</p>
            <em><p style={{marginTop: 10}}>{onySay}</p></em>
            <p style={{marginTop:10,marginBottom:10}}><a className="link" target="_blank" rel="noreferrer" href="">{blogIcp}</a></p>
            <p>Powered by <span>Memory</span></p>
        </footer>
    </>
}

export default Footer