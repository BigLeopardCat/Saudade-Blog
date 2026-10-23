import {useEffect, type ReactNode} from 'react';
import {message} from 'antd';
import {useNavigate} from 'react-router-dom';
import {useAuthToken} from '../utils/useAuthToken';
import {isAdminToken} from '../utils/auth';

/** UI gate only: every API still verifies authorization on the server. */
export function AuthRouter({children}: {children: ReactNode}) {
    const navigate = useNavigate();
    const token = useAuthToken();
    const allowed = isAdminToken(token);

    useEffect(() => {
        if (allowed) return;
        message.error(!token ? '请先登录！' : '无权限访问后台');
        navigate('/', {replace: true});
    }, [allowed, token, navigate]);

    // Returning null prevents effects and lazy imports in the protected subtree.
    return allowed ? <>{children}</> : null;
}
