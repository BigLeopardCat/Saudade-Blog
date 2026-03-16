import './index.sass';
import { message } from 'antd';
import { useEffect, useState } from 'react';
import * as React from 'react';
import { useDispatch } from 'react-redux';
import {fetchToken} from "../../store/components/user.tsx";
import { useNavigate } from 'react-router-dom';
import getToken from '../../apis/getToken';
import UserData from "../../interface/UserData";

const Login: React.FC = () => {
    const [account, setAccount] = useState<string>('');
    const [password, setPassword] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const dispatch = useDispatch();
    const navigate = useNavigate();

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

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        
        if (isLoading) return;

        const data:UserData = {
            username:account,
            password,
        };
        
        setIsLoading(true);
        try {
            const status:number = await dispatch<any>(fetchToken(data));
            if (status === 200) {
                message.success('登录成功');
                navigate('/dashboard');
            }
        } catch (error) {
            message.error('登录失败，账号或密码错误！');
        } finally {
            setIsLoading(false);
        }
    };

    const handleInvalid = (e: React.FormEvent<HTMLInputElement>) => {
        e.preventDefault();
        if (!isLoading) {
             message.warning(`请填写${e.currentTarget.placeholder}`);
        }
    };

    return (
        <div className="login-box">
            <h2>Saudade Blog</h2>
            <form action="" onSubmit={handleSubmit}>
                <div className="user-box">
                    <input type="text" name="account"
                           value={account}
                           required
                           onChange={handleChange}
                           onInvalid={handleInvalid}
                           autoComplete='off'
                           disabled={isLoading}
                    />
                    <label>Username</label>
                </div>
                <div className="user-box">
                    <input type="password" name="password"
                           required
                           value={password}
                           onChange={handleChange}
                           onInvalid={handleInvalid}
                           autoComplete='off'
                           disabled={isLoading}
                    />
                    <label>Password</label>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <a>
                        <span></span>
                        <span></span>
                        <span></span>
                        <span></span>
                        <input 
                            type="submit" 
                            value={isLoading ? "Logging in..." : "Submit"} 
                            disabled={isLoading}
                            style={{ 
                                cursor: isLoading ? "not-allowed" : "pointer",
                                opacity: isLoading ? 0.7 : 1
                            }}
                        />
                    </a>
                    <a onClick={() => !isLoading && navigate("/")} className="return-btn" style={{ cursor: "pointer", opacity: isLoading ? 0.5 : 1, pointerEvents: isLoading ? 'none' : 'auto' }}>
                        <span></span>
                        <span></span>
                        <span></span>
                        <span></span>
                        Return
                    </a>
                </div>
            </form>
        </div>
    );
};

export default Login;
