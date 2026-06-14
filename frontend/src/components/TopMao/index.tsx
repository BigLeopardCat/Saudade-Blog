import './index.sass';
import { useEffect, useState } from 'react';

const TopMao = () => {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const handleScroll = () => {
            setVisible(window.scrollY > 500);
        };
        handleScroll();
        window.addEventListener('scroll', handleScroll);
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const BackToTop = () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    return (
        <div className={`TopMao ${visible ? 'TopMaoShow' : ''}`} onClick={BackToTop}></div>
    );
};

export default TopMao;
