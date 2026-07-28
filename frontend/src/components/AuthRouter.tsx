import {useEffect, ReactNode} from 'react';
import {message} from 'antd';
import {useNavigate} from 'react-router-dom';
import getToken from "../apis/getToken.tsx";

interface AuthRouterProps {
    children: ReactNode;
}

// 解析 JWT payload 获取 role
function getRoleFromToken(token: string): string | null {
    try {
        const payload = token.split('.')[1];
        const decoded = JSON.parse(atob(payload));
        return decoded.role || null;
    } catch {
        return null;
    }
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
