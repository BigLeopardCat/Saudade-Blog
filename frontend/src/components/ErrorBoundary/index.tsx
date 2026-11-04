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
                        <a className="errorBoundary__btn" href="/">回到首页</a>
                    </div>
                </div>
            </div>
        )
    }
}

export default ErrorBoundary
