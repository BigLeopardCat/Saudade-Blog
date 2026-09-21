import './index.sass';
import { message, Modal } from 'antd';
import { useEffect, useState } from 'react';
import * as React from 'react';
import { useDispatch } from 'react-redux';
import { fetchToken } from "../../store/components/user.tsx";
import { useNavigate } from 'react-router-dom';
import getToken from '../../apis/getToken';
import UserData from "../../interface/UserData";
import SeoHelmet from "../../components/SeoHelmet";

type NoticeKind = 'register' | 'forgot' | null;

const Login: React.FC = () => {
    const [account, setAccount] = useState<string>('');
    const [password, setPassword] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [showPwd, setShowPwd] = useState<boolean>(false);
    const [notice, setNotice] = useState<NoticeKind>(null);
    const [resetUsername, setResetUsername] = useState('');
    const [resetCode, setResetCode] = useState('');
    const [resetPassword, setResetPassword] = useState('');
    const [resetPasswordAgain, setResetPasswordAgain] = useState('');
    const [resetLoading, setResetLoading] = useState(false);
    const [messageApi, contextHolder] = message.useMessage();
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

    const handleResetPassword = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (resetPassword !== resetPasswordAgain) {
            messageApi.error('两次输入的新密码不一致');
            return;
        }
        setResetLoading(true);
        try {
            const response = await fetch('/api/password/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: resetUsername,
                    recovery_code: resetCode,
                    new_password: resetPassword,
                }),
            });
            const result = await response.json();
            if (response.ok && result.code === 200) {
                messageApi.success('密码修改成功，请使用新密码登录');
                setNotice(null);
                setResetCode('');
                setResetPassword('');
                setResetPasswordAgain('');
            } else {
                messageApi.error(result.message || '恢复失败，请检查恢复码');
            }
        } catch {
            messageApi.error('恢复服务暂不可用，请稍后再试');
        } finally {
            setResetLoading(false);
        }
    };

    // 提示弹窗的页脚：两个出口分得很清楚——"知道了"只关窗；"去河灯集留言"才跳转
    // （antd 默认的 ok/cancel 里 cancel 还兼管遮罩点击，语义会串，所以自绘页脚）
    const noticeFooter = (
        <div className="login-modal-foot">
            <button type="button" className="login-modal-ghost"
                    onClick={() => { setNotice(null); navigate('/guestbook'); }}>
                去河灯集留言
            </button>
            <button type="button" className="login-modal-primary" onClick={() => setNotice(null)}>
                知道了
            </button>
        </div>
    );

    return (
        <>
            <SeoHelmet title="登录" url="/login" />
            {contextHolder}
            <div className="login-page">
                <div className="login-box">
                    <header className="login-brand">
                        <h2>Saudade Blog</h2>
                        <p className="login-sub">登录后体验完整服务</p>
                    </header>

                    <form onSubmit={handleSubmit}>
                        <div className="field">
                            <label htmlFor="account">账号</label>
                            <input
                                id="account"
                                type="text"
                                name="account"
                                value={account}
                                required
                                placeholder="用户名"
                                onChange={handleChange}
                                onInput={handleInput}
                                onInvalid={handleInvalid}
                                autoComplete='username'
                                autoFocus
                                disabled={isLoading}
                            />
                        </div>

                        <div className="field field-pwd">
                            <label htmlFor="password">密码</label>
                            <input
                                id="password"
                                type={showPwd ? 'text' : 'password'}
                                name="password"
                                value={password}
                                required
                                placeholder="密码"
                                onChange={handleChange}
                                onInput={handleInput}
                                onInvalid={handleInvalid}
                                autoComplete='current-password'
                                disabled={isLoading}
                            />
                            <button
                                type="button"
                                className="pwd-toggle"
                                onClick={() => setShowPwd(v => !v)}
                                aria-label={showPwd ? '隐藏密码' : '显示密码'}
                                tabIndex={-1}
                            >
                                {showPwd ? '隐藏' : '显示'}
                            </button>
                        </div>

                        <button type="submit" className="login-submit" disabled={isLoading}>
                            {isLoading ? '登录中…' : '登 录'}
                        </button>

                        <div className="login-links">
                            <button type="button" onClick={() => setNotice('forgot')}>忘记密码？</button>
                            <span className="sep">·</span>
                            <button type="button" onClick={() => setNotice('register')}>注册账号</button>
                        </div>
                    </form>

                    <div className="login-foot">
                        <a
                            href="/"
                            onClick={(e) => { e.preventDefault(); navigate('/'); }}
                        >
                            ← 返回首页
                        </a>
                    </div>
                </div>

                {/* 注册：合规声明 */}
                <Modal
                    open={notice === 'register'}
                    title="注册账号"
                    centered
                    onCancel={() => setNotice(null)}
                    footer={noticeFooter}
                >
                    <div className="login-modal-body">
                        <p>本站仅在提供账号服务所必需的范围内处理注册信息。</p>
                        <ul>
                            <li>注册信息仅用于登录、身份识别和账号安全维护；</li>
                            <li>不会将账号信息出售、出租或用于与本站服务无关的用途；</li>
                            <li>留言、说说、河灯等访客功能<b>无需登录</b>即可使用。</li>
                        </ul>
                    </div>
                </Modal>

                {/* 忘记密码：当前没有可靠的邮箱身份核验通道 */}
                <Modal
                    open={notice === 'forgot'}
                    title="重置密码"
                    centered
                    onCancel={() => setNotice(null)}
                    footer={noticeFooter}
                >
                    <form className="login-reset-form" onSubmit={handleResetPassword}>
                        <p>请向管理员获取 15 分钟内有效的一次性恢复码。</p>
                        <input required value={resetUsername} onChange={e => setResetUsername(e.target.value)} placeholder="用户名" autoComplete="username" />
                        <input required value={resetCode} onChange={e => setResetCode(e.target.value)} placeholder="一次性恢复码" autoComplete="one-time-code" />
                        <input required minLength={8} type="password" value={resetPassword} onChange={e => setResetPassword(e.target.value)} placeholder="新密码（至少 8 位）" autoComplete="new-password" />
                        <input required minLength={8} type="password" value={resetPasswordAgain} onChange={e => setResetPasswordAgain(e.target.value)} placeholder="再次输入新密码" autoComplete="new-password" />
                        <button type="submit" className="login-modal-primary" disabled={resetLoading}>{resetLoading ? '修改中…' : '确认修改密码'}</button>
                    </form>
                </Modal>
            </div>
        </>
    );
};

export default Login;
