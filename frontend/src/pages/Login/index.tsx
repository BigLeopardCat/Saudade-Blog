import './index.sass';
import { Avatar, ConfigProvider, message, Modal, theme as antdTheme } from 'antd';
import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import * as React from 'react';
import { useDispatch } from 'react-redux';
import { fetchToken } from "../../store/components/user.tsx";
import { useNavigate } from 'react-router-dom';
import getToken from '../../apis/getToken';
import { useViewerAvatar } from '../../components/UserCenter/identity';
import { isAdminToken } from '../../utils/auth.ts';
import UserData from "../../interface/UserData";
import SeoHelmet from "../../components/SeoHelmet";

type NoticeKind = 'register' | 'forgot' | null;

// 弹窗配色：登录页是深色页面，而 antd 弹窗默认是浅色的（全站其余弹窗都长在浅色后台里，
// 所以没有全局深色主题可用）⇒ 不套深色算法时，弹窗正文的浅色字全落在白底上，既"风格和
// 外部不一致"，字也基本看不见（20260922 用户实测）。
// 走官方途径（darkAlgorithm + 河灯金主色）而不是覆写 `.ant-modal-*` 的 CSS：antd v5 是
// CSS-in-JS 注入，手写选择器得跟它拼特异性，且标题/关闭图标吃的是 token 而非一条
// background——改一条治不了全身。
const DARK_MODAL_THEME = {
    algorithm: antdTheme.darkAlgorithm,
    token: {
        colorBgElevated: '#1b2330',   // 与登录卡片同族的墨蓝（不用 antd 默认的 #141414）
        colorPrimary: '#e8b866',      // 河灯金深端，与 .login-submit 的渐变同源
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
    // 20260924：品牌区那行小字「登录后体验完整服务」换成**访客自己的三态头像**（与头部
    // 同一个 hook，不是另写一套）：正常登录=自己的头像；退出登录/令牌过期但本机挂过账号
    // =上次那个账号的头像；从没登录过=默认头像。登录页正是"退出后落回"的地方——令牌没了，
    // 展示身份不该跟着失忆（三态的选择与缓存见 components/UserCenter/identity.ts）。
    const viewerAvatar = useViewerAvatar();

    useEffect(() => {
        const token = getToken();
        if (token) {
            // 20260922：普通用户登录后不再往 /dashboard 送——那条路由被 AuthRouter 收成
            // 管理员专属，普通用户只会看到"无权限访问后台"再被弹回首页（个人中心一期之前
            // 没有别的地方可去）。管理员仍然直达后台。
            navigate(isAdminToken(token) ? '/dashboard' : '/');
        }
    }, [navigate]);

    // 关窗一律走这里：顺带清掉恢复表单的残留。恢复码是一次性的——留着上一次的码再提交
    // 只会得到"账号或恢复码无效"，用户不知道为什么（20260922 修）。
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
            <div className="login-page">
                <div className="login-box">
                    <header className="login-brand">
                        <h2>Saudade Blog</h2>
                        {/* 这一格原来是小字「登录后体验完整服务」，20260924 起换成访客自己的
                            三态头像（同一个 useViewerAvatar，尺寸比头部那个大一号）。 */}
                        <Avatar className="login-avatar" src={viewerAvatar} size={64} alt="访客头像" />
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
                            {/* 打开时把上面填的账号带过去：多数人是先输账号、再想起忘了密码 */}
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

                <ConfigProvider theme={DARK_MODAL_THEME}>
                    {/* 注册：本站不开自助注册，这里只做声明，不给任何"去注册"的出口 */}
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

                    {/* 忘记密码：无邮箱账号，只能靠管理员签发的一次性恢复码。
                        不开页脚——一条表单下面再放"取消"是多余的（右上角 X / 遮罩 / Esc 都能关）；
                        关窗后的表单清理由 closeNotice 统一负责。 */}
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
