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
                        <p className="login-sub">登录后进入后台管理</p>
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

                {/* 注册：合规提示（暂不开放） */}
                <Modal
                    open={notice === 'register'}
                    title="注册暂不开放"
                    centered
                    onCancel={() => setNotice(null)}
                    footer={noticeFooter}
                >
                    <div className="login-modal-body">
                        <p>本站是个人博客，<b>不对外收集个人信息</b>，因此暂不开放自助注册。</p>
                        <ul>
                            <li>账号仅用于博主本人管理后台，由博主统一开通；</li>
                            <li>留言、说说、河灯等访客功能<b>无需登录</b>即可使用；</li>
                            <li>若确需账号，可在「河灯集」留言说明用途，博主会与你联系。</li>
                        </ul>
                    </div>
                </Modal>

                {/* 忘记密码：无邮箱/短信通道，只能人工重置 */}
                <Modal
                    open={notice === 'forgot'}
                    title="重置密码"
                    centered
                    onCancel={() => setNotice(null)}
                    footer={noticeFooter}
                >
                    <div className="login-modal-body">
                        <p>本站没有邮箱/短信通道，<b>不支持自助重置密码</b>。</p>
                        <ul>
                            <li>请在「河灯集」留言说明情况（写上账号名与用途）；</li>
                            <li>博主核对身份后会为你重置，并把新口令单独告知你；</li>
                            <li>拿到新口令后请尽快自行修改。</li>
                        </ul>
                    </div>
                </Modal>
            </div>
        </>
    );
};

export default Login;
