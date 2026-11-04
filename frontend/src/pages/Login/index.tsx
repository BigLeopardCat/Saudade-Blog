import './index.sass';
import { Avatar, ConfigProvider, message, Modal, theme as antdTheme } from 'antd';
import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import * as React from 'react';
import { useDispatch } from 'react-redux';
import { fetchToken } from "../../store/components/user.tsx";
import { useNavigate } from 'react-router-dom';
import getToken from '../../apis/getToken';
import { readKnownUsers, selectLoginAvatar, useViewerAvatar } from '../../components/UserCenter/identity';
import { isAdminToken } from '../../utils/auth.ts';
import UserData from "../../interface/UserData";
import SeoHelmet from "../../components/SeoHelmet";
import { useIsDarkMode, useAutoThemeSwitch } from '../../theme';

type NoticeKind = 'register' | 'forgot' | null;

const DARK_MODAL_THEME = {
    algorithm: antdTheme.darkAlgorithm,
    token: {
        colorBgElevated: '#1b2330',   // 与登录卡片同族的墨蓝（不用 antd 默认的 #141414）
        colorPrimary: '#e8b866',      // 河灯金深端，与 .login-submit 的渐变同源
        borderRadius: 12,
    },
};

// 白天档 = antd 默认浅色算法 + 和纸主色。**`token` 只能给字面量**：`colorPrimary` 是
// 派生色（hover / 选中 / 边框都从它算），传 `var(--washi-pink-deep)` 会算不出来。
// 值 = `--washi-pink-deep` 白天的那个（两处一起改时对一下 `src/index.css`）。
const LIGHT_MODAL_THEME = {
    token: {
        colorPrimary: '#d94f9a',
        borderRadius: 12,
    },
};

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
    const viewerAvatar = useViewerAvatar();
    useAutoThemeSwitch();
    const isDark = useIsDarkMode();

    // 页面底（含卡片外的部分、手机端回弹露出的部分）挂在 body 上：sass 里那份 `body`
    // 规则从前是**无条件**的深色渐变，现在按这两颗类分档。`.login-page` 自己也带同一张
    // 底，所以首帧不会闪一下白。
    useEffect(() => {
        document.body.classList.add('login-route');
        return () => document.body.classList.remove('login-route');
    }, []);
    // 夜间那颗类还负责**弹窗**：modal 走 Portal 挂在 body 下，够不着 `.login-page.frontDark`，
    // 手写的那批 `.login-modal-*` / `.login-reset-form` 配色得靠它分档。
    useEffect(() => {
        document.body.classList.toggle('login-dark', isDark);
        return () => document.body.classList.remove('login-dark');
    }, [isDark]);
    // 本机登录过的账号清单只读一次：它是 localStorage 里的东西，用户在这页打字时不会变
    // （登录成功会整页跳走）。判据与"为什么不能按输入的名字去查头像"见 selectLoginAvatar。
    const [knownUsers] = useState(() => readKnownUsers());
    const avatar = selectLoginAvatar(viewerAvatar, knownUsers, account);

    useEffect(() => {
        const token = getToken();
        if (token) {
            navigate(isAdminToken(token) ? '/dashboard' : '/');
        }
    }, [navigate]);

    const closeNotice = () => {
        setNotice(null);
        setResetUsername('');
        setResetCode('');
        setResetPassword('');
        setResetPasswordAgain('');
    };

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
                // 令牌此刻已写入 localStorage（store 的 setToken 顺便派发 auth-change，
                // 头部据此把登录态从 0 翻到 1——头部是常驻组件，不重挂载，不靠刷新）
                const token = getToken();
                setTimeout(() => navigate(isAdminToken(token) ? '/dashboard' : '/'), 500);
            } else {
                // result.message 的类型退化成 {}（store 的返回类型没写细），运行时是后端的中文串
                messageApi.error(typeof result.message === 'string' && result.message
                    ? result.message
                    : '登录失败，账号或密码错误！');
            }
        } catch {
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
        // 回车也会走这条路，而按钮的 disabled 拦不住隐式提交（输入框仍可编辑）
        if (resetLoading) return;
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
            // 本仓的失败契约是 HTTP 200 + code 500，只看 response.ok 会把失败当成功
            if (response.ok && result.code === 200) {
                messageApi.success('密码修改成功，请使用新密码登录');
                closeNotice();
            } else {
                messageApi.error(result.message || '恢复失败，请检查恢复码');
            }
        } catch {
            messageApi.error('恢复服务暂不可用，请稍后再试');
        } finally {
            setResetLoading(false);
        }
    };

    return (
        <>
            <SeoHelmet title="登录" url="/login" />
            {contextHolder}
            <div className={isDark ? 'login-page frontDark' : 'login-page'}>
                <div className="login-box">
                    <header className="login-brand">
                        <h2>Saudade Blog</h2>
                        <Avatar className="login-avatar" src={avatar} size={84} alt="访客头像" />
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
                                title={showPwd ? '隐藏密码' : '显示密码'}
                                tabIndex={-1}
                            >
                                {showPwd ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                            </button>
                        </div>

                        <button type="submit" className="login-submit" disabled={isLoading}>
                            {isLoading ? '登录中…' : '登 录'}
                        </button>

                        <div className="login-links">
                            <button type="button" onClick={() => { setResetUsername(account); setNotice('forgot'); }}>
                                忘记密码？
                            </button>
                            <span className="sep">·</span>
                            <button type="button" onClick={() => setNotice('register')}>注册账号</button>
                        </div>
                    </form>

                    <div className="login-foot">
                        <a
                            href="/"
                            onClick={(e) => { e.preventDefault(); navigate('/'); }}
                        >
                            返回首页
                        </a>
                    </div>
                </div>

                <ConfigProvider theme={isDark ? DARK_MODAL_THEME : LIGHT_MODAL_THEME}>
                    <Modal
                        open={notice === 'register'}
                        title="注册账号"
                        centered
                        onCancel={closeNotice}
                        footer={(
                            <div className="login-modal-foot is-center">
                                <button type="button" className="login-modal-primary" onClick={closeNotice}>
                                    知道了
                                </button>
                            </div>
                        )}
                    >
                        <div className="login-modal-body">
                            <p>本站<b>不开放自助注册</b>，账号由博主（管理员）在后台开设。</p>
                            <ul>
                                <li>浏览文章、首页等阅读功能<b>无需登录</b>；</li>
                                <li>留言、说说、河灯留言等<b>发布功能需要登录</b>后才能使用；</li>
                                <li>账号信息仅用于登录、身份识别和账号安全维护，不会出售、出租或用于与本站服务无关的用途。</li>
                            </ul>
                        </div>
                    </Modal>

                    <Modal
                        open={notice === 'forgot'}
                        title="重置密码"
                        centered
                        onCancel={closeNotice}
                        footer={null}
                    >
                        <form className="login-reset-form" onSubmit={handleResetPassword}>
                            <p>请向博主索取一次性恢复码（15 分钟内有效、只能用一次）。</p>
                            <input
                                required
                                value={resetUsername}
                                onChange={e => setResetUsername(e.target.value)}
                                placeholder="用户名"
                                aria-label="用户名"
                                autoComplete="username"
                                disabled={resetLoading}
                            />
                            <input
                                required
                                value={resetCode}
                                onChange={e => setResetCode(e.target.value)}
                                placeholder="一次性恢复码"
                                aria-label="一次性恢复码"
                                autoComplete="one-time-code"
                                disabled={resetLoading}
                            />
                            <input
                                required
                                minLength={8}
                                type="password"
                                value={resetPassword}
                                onChange={e => setResetPassword(e.target.value)}
                                placeholder="新密码（至少 8 位）"
                                aria-label="新密码"
                                autoComplete="new-password"
                                disabled={resetLoading}
                            />
                            <input
                                required
                                minLength={8}
                                type="password"
                                value={resetPasswordAgain}
                                onChange={e => setResetPasswordAgain(e.target.value)}
                                placeholder="再次输入新密码"
                                aria-label="再次输入新密码"
                                autoComplete="new-password"
                                disabled={resetLoading}
                            />
                            <button type="submit" className="login-modal-primary" disabled={resetLoading}>
                                {resetLoading ? '修改中…' : '确认修改密码'}
                            </button>
                        </form>
                    </Modal>
                </ConfigProvider>
            </div>
        </>
    );
};

export default Login;
