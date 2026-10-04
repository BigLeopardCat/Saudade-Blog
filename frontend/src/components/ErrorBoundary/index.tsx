/**
 * React 渲染期错误的兜底（20261004）。
 *
 * 为什么需要它：`boot.js` 的全局捕获与 `utils/report.ts` 只管**事件与网络**，
 * 渲染期抛错两者都收不到——React 18 在无人接住时会把整棵子树卸载，用户看到的是一片
 * 空白，而日志里是干净的。这一层把那一片空白换成"看得见的故障 + 一条日志"。
 *
 * 两个挂载点、用 `scope` 区分（同一条日志要能看出崩在哪一层）：
 *   - `App.tsx` 的 `<Outlet/>` 外：**页面内容**崩了，头/尾/看板娘都还在（scope="page"）；
 *   - `main.tsx` 的 RouterProvider 外：**整个壳**崩了，包括后台那颗壳（scope="app"）。
 *
 * 只接渲染期错误，不接异步/事件回调里的（那些由 `utils/report.ts` 与 boot.js 管）——
 * 这是 React error boundary 本身的能力边界，不是这里的选择。
 */
import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { reportError } from '../../utils/report'
import { isStaleChunkError, recoverFromStaleChunk } from '../../utils/staleChunk'
import { readDarkMode } from '../../theme'
import './index.sass'

interface Props {
    children: ReactNode
    /** 哪一层接住的（进日志）。缺省 "page"。 */
    scope?: string
}

interface State {
    error: Error | null
}

class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null }

    static getDerivedStateFromError(error: Error): State {
        return { error }
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        // 换代后的悬空 chunk（20261005，A 案）：这一页还停在上一版，它 `import()` 出去的
        // 分块名带老哈希，而部署时 dist 差集已经把那个文件删了。**这类错误重试永远不会
        // 成功**（重新挂载子树拿的还是同一个 URL），唯一的出路是整页刷新 —— 交给带闸的
        // 自愈函数（一分钟内只刷一次，闸拦下时就靠下面那张卡请用户手动刷）。
        // 这一支**不报 react_error**：日志由自愈入口落一条 module_load_fail，一次事故一行。
        if (isStaleChunkError(error)) {
            recoverFromStaleChunk(error)
            return
        }
        // componentStack 是这里最有价值的一段：它指出**哪个组件**抛的，
        // 而 error.stack 只到 minify 后的函数名（生产构建）。
        reportError({
            type: 'react_error',
            message: (this.props.scope || 'page') + ': ' + (error?.message || String(error)),
            stack: String(error?.stack || '') + '\n--- componentStack ---\n' + String(info?.componentStack || ''),
            url: location.href,
        })
    }

    render() {
        const { error } = this.state
        if (!error) return this.props.children
        // 兜底 UI 可能落在 `.frontDark` **之外**（main.tsx 那层边界在 App 的根 div 之上），
        // 所以夜间要自己把令牌档的类名带上，否则深色站里弹出一张亮白纸。
        const className = readDarkMode()
            ? 'errorBoundary frontDark frontRoot'
            : 'errorBoundary'
        // 换代那一支单独一张卡（见 `componentDidCatch`）：**不能给「重试」**——那一颗是
        // 重新挂载子树，拿的还是同一个已经不存在的 URL，点几次都一样。唯一有意义的动作
        // 是整页刷新。原始报错文本也不展示：对访客它只是一串带哈希的文件名，没有可操作性
        // （诊断信息照旧进 monitor.log，见 `recoverFromStaleChunk` 里那条 module_load_fail）。
        const stale = isStaleChunkError(error)
        return (
            <div className={className}>
                <div className="errorBoundary__card">
                    <div className="errorBoundary__title">
                        {stale ? '页面已更新' : '页面出了点小问题'}
                    </div>
                    <div className="errorBoundary__desc">
                        {stale
                            ? '网站刚更新过，这一页还停在上一版，它要的资源已经换掉了。刷新一下就接着用。'
                            : '这一块内容没能加载出来，已经记录下来。刷新一下通常就好了。'}
                    </div>
                    {!stale && (
                        <pre className="errorBoundary__msg">{error.message || String(error)}</pre>
                    )}
                    <div className="errorBoundary__actions">
                        <button
                            className="errorBoundary__btn errorBoundary__btn--primary"
                            onClick={() => {
                                // 换代：整页刷新（不是 setState 重挂子树）。这里的自愈闸
                                // 已经拦下过一次自动刷新，所以这一次由用户按钮触发 ——
                                // 闸只管自动那一路，手动点刷新永远放行。
                                if (stale) location.reload()
                                else this.setState({ error: null })
                            }}
                        >
                            {stale ? '刷新页面' : '重试'}
                        </button>
                        {/* 用 <a href> 而不是路由跳转：这层边界可能整个在 Router 之外，
                            拿不到 useNavigate 的上下文 */}
                        <a className="errorBoundary__btn" href="/">回到首页</a>
                    </div>
                </div>
            </div>
        )
    }
}

export default ErrorBoundary
