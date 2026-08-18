import './index.sass';
import { message } from 'antd';
import { useEffect, useState, useRef } from 'react';
import * as React from 'react';
import { useDispatch } from 'react-redux';
import { fetchToken } from "../../store/components/user.tsx";
import { useNavigate } from 'react-router-dom';
import getToken from '../../apis/getToken';
import UserData from "../../interface/UserData";
import SeoHelmet from "../../components/SeoHelmet";

const Login: React.FC = () => {
    const [account, setAccount] = useState<string>('');
    const [password, setPassword] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [messageApi, contextHolder] = message.useMessage();
    const dispatch = useDispatch();
    const navigate = useNavigate();
    const submitBtnRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const token = getToken();
        if (token) {
            navigate('/dashboard');
        }
    }, [navigate]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        if (name === 'account') {
            setAccount(value);
        } else if (name === 'password') {
            setPassword(value);
        }
    };

    // 处理浏览器自动填充（onInput 比 onChange 更早触发 autofill 事件）
    const handleInput = (e: React.FormEvent<HTMLInputElement>) => {
        const { name, value } = e.currentTarget;
        if (name === 'account' && value !== account) {
            setAccount(value);
        } else if (name === 'password' && value !== password) {
            setPassword(value);
        }
    };

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        
        if (isLoading) return;

        const data: UserData = {
            username: account,
            password,
        };
        
        setIsLoading(true);
        try {
            // @ts-ignore
            const result = await dispatch(fetchToken(data));
            if (result.status === 200) {
                messageApi.success('登录成功');
                setTimeout(() => navigate('/dashboard'), 500);
            } else {
                messageApi.error(result.message || '登录失败，账号或密码错误！');
            }
        } catch (error) {
            messageApi.error('登录失败，账号或密码错误！');
        } finally {
            setIsLoading(false);
        }
    };

    const handleInvalid = (e: React.FormEvent<HTMLInputElement>) => {
        e.preventDefault();
        if (!isLoading) {
             const target = e.target as HTMLInputElement;
             messageApi.warning(`请填写${target.name === 'account' ? '用户名' : '密码'}`);
        }
    };

    const handleLoginClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        if (!isLoading) {
            if (submitBtnRef.current) {
                submitBtnRef.current.click();
            } else {
                const form = e.currentTarget.closest('form');
                if (form) form.requestSubmit();
            }
        }
    };

    return (
        <>
            <SeoHelmet title="登录" url="/login" />
            {contextHolder}
            <div className="login-box">
                <h2>Saudade Blog</h2>
                <form onSubmit={handleSubmit}>
                    <button type="submit" ref={submitBtnRef} style={{ display: 'none' }}></button>
                    <div className="user-box">
                        <input type="text" name="account"
                               value={account}
                               required
                               onChange={handleChange}
                               onInput={handleInput}
                               onInvalid={handleInvalid}
                               autoComplete='username'
                               disabled={isLoading}
                        />
                        <label>Username</label>
                    </div>
                    <div className="user-box">
                        <input type="password" name="password"
                               required
                               value={password}
                               onChange={handleChange}
                               onInput={handleInput}
                               onInvalid={handleInvalid}
                               autoComplete='current-password'
                               disabled={isLoading}
                        />
                        <label>Password</label>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <a href="#" onClick={handleLoginClick} style={{ cursor: isLoading ? 'not-allowed' : 'pointer' }}>
                            <span></span>
                            <span></span>
                            <span></span>
                            <span></span>
                            <div className="login-text">
                                {isLoading ? 'Logged in...' : 'Login'}
                            </div>
                        </a>
                        <a href="/" className="return-btn" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
                             <span></span>
                            <span></span>
                            <span></span>
                            <span></span>
                            Return
                        </a>
                    </div>
                </form>
            </div>
        </>
    );
};

export default Login;
