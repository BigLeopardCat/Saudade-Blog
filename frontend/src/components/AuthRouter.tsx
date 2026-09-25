import {useEffect, ReactNode} from 'react';
import {message} from 'antd';
import {useNavigate} from 'react-router-dom';
import getToken from "../apis/getToken.tsx";
import {isAdminToken} from "../utils/auth.ts";

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
        // 判据统一走 isAdminToken（admin 或 superadmin）——不要在这里写死 'admin'，
        // 后台准入在 Rust 侧也只有一处判据（authz::can_access_console），两边保持同形
        if (!isAdminToken(token)) {
            message.error('无权限访问后台');
            navigate('/');
        }
    }, []);

    return <>{children}</>;
}
