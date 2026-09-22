import {useEffect, ReactNode} from 'react';
import {message} from 'antd';
import {useNavigate} from 'react-router-dom';
import getToken from "../apis/getToken.tsx";
import {getRoleFromToken} from "../utils/auth.ts";

interface AuthRouterProps {
    children: ReactNode;
}


export function AuthRouter({children}: AuthRouterProps) {
    const navigate = useNavigate();

    useEffect(() => {
        const token = getToken();
        if (!token) {
            message.error('请先登录！');
            navigate('/');
            return;
        }
        const role = getRoleFromToken(token);
        if (role !== 'admin') {
            message.error('无权限访问后台');
            navigate('/');
        }
    }, []);

    return <>{children}</>;
}
