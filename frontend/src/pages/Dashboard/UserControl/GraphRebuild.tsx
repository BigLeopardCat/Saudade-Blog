import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Input, InputNumber, Radio, Select, Tag } from 'antd'
import {
    ok,
    errMsg,
    startGraphRebuild,
    getGraphRebuildStatus,
    cancelGraphRebuild,
} from '../../../apis/GraphMethods.tsx'
import type {
    GraphBuildParams,
    GraphBuildResult,
    GraphBuildState,
    GraphBuildStatus,
} from '../../../interface/GraphType'
import './GraphRebuild.sass'

/**
 * 「向量图谱」页签（20261003 用户第 2 条）：手动把图谱与当前的文章重新对齐、重算一遍。
 *
 * 为什么要有这一页：[展示柜那份图谱产物](../frontend/public/graph) 从前只能靠
 * `vite build` 更新，于是**别人迁移这个项目时根本用不了**——他 clone 下去，图上还是
 * 原站的文章，而他自己发的新文章永远进不了图。现在重建由这一个按钮触发：服务端起
 * 后台任务写产物，前台刷新即新图（**不需要重新部署**）。
 *
 * 只算公开文章这件事不由页面保证：脚本走 `/api/public/notes` 取语料，而 Rust 那个
 * 接口的 SQL 里就写着 `IsPublic=true AND Status!='draft'`（`src/routes/notes.rs`）。
 * 页面能给的只是"填错 api_base 会拉错站点的语料"这一条提示。
 *
 * 三条纪律：
 *   · **进度靠轮询**（1.5s），不靠长连接——建图是一两分钟起的活儿，起任务的请求
 *     必须立刻返回，否则一个代理超时就会让用户以为"点了没反应"；
 *   · **失败分两类**：机器此刻不行（busy/low_memory/uv_missing）是后端的中文 message，
 *     人不行（非管理员）是 HTTP 403 —— 都走 `errMsg()`，本页只负责显示；
 *   · **报告要说实话**：`--dry-run` 没调 embedding，与"调了但全命中缓存 0/0"是两件事，
 *     所以向量用量那一行在拿不到数字时写"没调/日志里没有"，**绝不写 0**。
 */

/** 轮询间隔。状态查询只读一个 state.json + 一次 /proc/meminfo，很便宜；
 *  建图本身要跑几分钟，更密的轮询不带来新信息，只会让日志刷屏。 */
const POLL_MS = 1500

/** 列表接口一页的上限（`src/routes/notes.rs` 的 page_size clamp 1..1000）。
 *  脚本正好按 1000 拉 ⇒ **正好 1000 就可能是被截断的**（第 1001 篇开始进不了图）。 */
const PAGE_LIMIT = 1000

const STATUS_TEXT: Record<GraphBuildStatus, string> = {
    idle: '未运行',
    running: '运行中',
    ok: '成功',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '被中断',
}
const STATUS_COLOR: Record<GraphBuildStatus, string> = {
    idle: 'default',
    running: 'processing',
    ok: 'success',
    failed: 'error',
    cancelled: 'warning',
    interrupted: 'warning',
}

function fmtBytes(n?: number | null): string {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 向量用量那一行的措辞（**这一处最容易说谎**，所以单独抽出来）：
 *  agent 侧拿不到日志里那行 `embedding 新增 N 条（缓存命中 M 条）` 时给的是 null
 *  （`_collect_result` → `_embed_stats`），而不是 0/0——页面必须把"没调"说出来。 */
function embedText(r: GraphBuildResult): string {
    if (typeof r.embed_new !== 'number' || typeof r.embed_hit !== 'number') {
        return '向量用量：这次没有调 embedding（试跑，或者日志里没有那一行）'
    }
    return `向量用量：新增 ${r.embed_new} 条，缓存命中 ${r.embed_hit} 条`
}

const GraphRebuild = () => {
    const [st, setSt] = useState<GraphBuildState | null>(null)
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    /** 首帧还没回来时的空白是"未知"，不是"未运行"——用 loading 区分，
     *  否则一进页就显示"未运行"，而实际上可能正在跑。 */
    const [loaded, setLoaded] = useState(false)

    const [maxNodes, setMaxNodes] = useState<number | null>(400)
    const [minChars, setMinChars] = useState<number | null>(400)
    const [layout, setLayout] = useState<'umap' | 'semantic' | 'pca'>('umap')
    const [excludeMode, setExcludeMode] = useState<'default' | 'none' | 'custom'>('default')
    const [excludeText, setExcludeText] = useState('')
    const [refresh, setRefresh] = useState(false)
    const [force, setForce] = useState(false)
    const [dryRun, setDryRun] = useState(false)
    const [apiBase, setApiBase] = useState('')
    /** 归属站点默认填**浏览器自己的 origin**：前台 `loader.ts::siteMatches` 拿产物的
     *  `site` 跟访客浏览器的 origin 比，不一致就显示「尚未为本站点生成」。
     *  留空 = 不署名，前台会当成"哪个站点都能显示"（老产物语义）。 */
    const [site, setSite] = useState(() => (typeof window === 'undefined' ? '' : window.location.origin))

    const logRef = useRef<HTMLPreElement | null>(null)

    const refreshStatus = useCallback(async () => {
        try {
            const res = await getGraphRebuildStatus()
            if (ok(res)) {
                setSt(res.data.data)
                setErr(null)
            } else {
                setErr(errMsg(res, '读不到重建状态'))
            }
        } catch {
            // 网络抖动：**不把已知状态清掉**（那会让页面从"运行中"倒退回"未运行"），
            // 只记一句原因；下一轮轮询通常会自愈。
            setErr('读不到重建状态（网络或服务暂时不可达）')
        } finally {
            setLoaded(true)
        }
    }, [])

    useEffect(() => { void refreshStatus() }, [refreshStatus])

    const running = st?.status === 'running'

    // 运行中才轮询：拿到终态那一刻 `running` 变 false，interval 自己就停了
    // ——不需要在回调里判断"要不要继续"，那种写法一旦漏一处就会永远轮下去。
    useEffect(() => {
        if (!running) return
        const t = window.setInterval(() => { void refreshStatus() }, POLL_MS)
        return () => window.clearInterval(t)
    }, [running, refreshStatus])

    const tail = st?.tail ?? []
    // 日志自动滚到底（只在运行中；看历史日志时滚动位置不该被抢走）
    useEffect(() => {
        if (!running || !logRef.current) return
        logRef.current.scrollTop = logRef.current.scrollHeight
    }, [tail.length, running])

    /** 语料篇数从**日志尾巴**里读（脚本自己打的那行），不另开一个接口：
     *  这是"这次实际拉到了多少篇"，比任何估算都可信。 */
    const articleCount = useMemo(() => {
        for (let i = tail.length - 1; i >= 0; i--) {
            const m = /公开文章\s+(\d+)\s+篇/.exec(tail[i])
            if (m) return Number(m[1])
        }
        return null
    }, [tail])

    /** 表单 → 请求体。**只在真填了值时才带那个键**——`exclude_ids` 的三态就是靠
     *  "键在不在场"区分的（不传 = 脚本自带默认排除；空串 = 一个都不排除）。 */
    const buildParams = (mode: 'rebuild' | 'precheck'): GraphBuildParams | string => {
        const p: GraphBuildParams = { mode }
        if (apiBase.trim()) p.api_base = apiBase.trim()
        if (site.trim()) {
            // ⚠️ **必须带 scheme**：`saudade.site` 这种裸域名会被脚本原样写进 manifest
            // （`build_word_graph.py::origin_of()` 只在匹配到 `^https?://` 时才规整），
            // 而前端 `loader.ts::siteMatches` 里 `new URL()` 解析不了它 ⇒ 展品直接显示
            // 「尚未为本站点生成」**且没有任何错误日志**——整条链上没人校验过这个值
            // （Rust 只传、agent 只限长度 200）。填错的两种形态症状一样，界面上分不出来，
            // 所以在这一处拦掉：留空是合法的（= 不署名，任何站点都显示），非空就必须能解析。
            const s = site.trim()
            let okUrl = false
            try {
                const u = new URL(s)
                okUrl = (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
            } catch { okUrl = false }
            if (!okUrl) {
                return '归属站点要写成带协议的地址（例如 https://你的域名）；' +
                    '裸域名前端解析不了、产物会写进去但首页永远不显示。想不署名就留空'
            }
            p.site = s
        }
        if (mode === 'precheck') return p
        if (maxNodes != null) p.max_nodes = maxNodes
        if (minChars != null) p.min_chars = minChars
        p.layout = layout
        if (excludeMode === 'none') {
            p.exclude_ids = ''
        } else if (excludeMode === 'custom') {
            const t = excludeText.trim()
            if (!t) return '「自定义排除」至少要填一个文章 id——想一个都不排除请选上面那项'
            if (!/^\d+(\s*,\s*\d+)*$/.test(t)) return '排除 id 只能填数字，用英文逗号分隔（例如 9,10）'
            p.exclude_ids = t.replace(/\s+/g, '')
        }
        if (refresh) p.refresh = true
        if (force) p.force = true
        if (dryRun) p.dry_run = true
        return p
    }

    const start = async (mode: 'rebuild' | 'precheck') => {
        const p = buildParams(mode)
        if (typeof p === 'string') { setErr(p); return }
        setBusy(true)
        setErr(null)
        setNotice(null)
        try {
            const res = await startGraphRebuild(p)
            if (ok(res)) {
                const d = res.data.data
                if (d?.state) setSt(d.state)
                setNotice(mode === 'precheck'
                    ? '环境预检已开始（首次会下载依赖，可能要几分钟）'
                    : `重建已开始（run ${d?.run_id ?? '—'}），进度会自动刷新`)
                void refreshStatus()
            } else {
                setErr(errMsg(res, '无法开始'))
            }
        } catch {
            setErr('请求没发出去（网络或服务暂时不可达）')
        } finally {
            setBusy(false)
        }
    }

    const cancel = async () => {
        setBusy(true)
        try {
            const res = await cancelGraphRebuild()
            if (ok(res)) {
                const d = res.data.data
                setNotice(d?.cancelled
                    ? `已发送取消信号（${d.signal ?? 'TERM'}）——等进程退出后状态会变成「已取消」`
                    : '当前没有正在运行的建图进程')
                void refreshStatus()
            } else {
                setErr(errMsg(res, '取消失败'))
            }
        } catch {
            setErr('取消请求没发出去（网络或服务暂时不可达）')
        } finally {
            setBusy(false)
        }
    }

    const status: GraphBuildStatus = st?.status ?? 'idle'
    const r = st?.result
    const memLow = typeof st?.mem_available_mb === 'number' && typeof st?.mem_min_mb === 'number'
        && st.mem_available_mb < st.mem_min_mb

    return (
        <div className='graphRebuild'>
            <p className='grIntro'>
                按当前<b>公开文章</b>重算一遍向量空间图谱，产物由服务端直接供出——
                <b>重建完刷新首页就能看到新图，不需要重新部署</b>。
                节点大小按文章热度（浏览/点赞/收藏/评论加权）画，不再是词的重要度。
            </p>

            <div className='grForm'>
                <div className='grRow'>
                    <span className='grLabel'>语料来源</span>
                    <Input
                        className='grInput'
                        value={apiBase}
                        onChange={(e) => setApiBase(e.target.value)}
                        placeholder='留空 = 服务端默认（本机回环直连 Rust 的公开接口）'
                        allowClear
                    />
                </div>
                <div className='grRow'>
                    <span className='grLabel'>归属站点</span>
                    <Input
                        className='grInput'
                        value={site}
                        onChange={(e) => setSite(e.target.value)}
                        placeholder='例如 https://你的域名（留空 = 前台任何站点都显示）'
                        allowClear
                    />
                </div>
                <div className='grRow'>
                    <span className='grLabel'>节点上限</span>
                    <InputNumber
                        min={20} max={2000} value={maxNodes}
                        onChange={(v) => setMaxNodes(v ?? null)}
                    />
                    <span className='grLabel grLabelGap'>最短正文</span>
                    <InputNumber
                        min={0} max={100000} value={minChars}
                        onChange={(v) => setMinChars(v ?? null)}
                    />
                    <span className='grHint'>正文字数低于它的文章整篇不入图</span>
                </div>
                <div className='grRow'>
                    <span className='grLabel'>布局</span>
                    <Select
                        className='grSelect'
                        value={layout}
                        onChange={(v) => setLayout(v)}
                        options={[
                            { value: 'umap', label: 'umap（默认，近邻保真最好）' },
                            { value: 'semantic', label: 'semantic' },
                            { value: 'pca', label: 'pca' },
                        ]}
                    />
                </div>
                <div className='grRow grRowTop'>
                    <span className='grLabel'>排除文章</span>
                    <Radio.Group
                        value={excludeMode}
                        onChange={(e) => setExcludeMode(e.target.value)}
                    >
                        <Radio value='default'>用脚本默认</Radio>
                        <Radio value='none'>一个都不排除</Radio>
                        <Radio value='custom'>自定义</Radio>
                    </Radio.Group>
                    {excludeMode === 'custom' && (
                        <Input
                            className='grInput'
                            value={excludeText}
                            onChange={(e) => setExcludeText(e.target.value)}
                            placeholder='例如 9,10,11'
                        />
                    )}
                </div>
                <div className='grRow grFlags'>
                    <label><input type='checkbox' checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> 只试跑（不算 embedding、不写产物）</label>
                    <label><input type='checkbox' checked={force} onChange={(e) => setForce(e.target.checked)} /> 质量门不过也出产物</label>
                    <label className='grDanger'>
                        <input type='checkbox' checked={refresh} onChange={(e) => setRefresh(e.target.checked)} /> 强制重嵌全部词（真花钱）
                    </label>
                </div>
            </div>

            <div className='grActions'>
                <Button type='primary' disabled={busy || running} onClick={() => start('rebuild')}>
                    开始重建
                </Button>
                <Button disabled={busy || running} onClick={() => start('precheck')}>
                    环境预检
                </Button>
                <Button danger disabled={busy || !running} onClick={cancel}>
                    取消
                </Button>
                <Button disabled={busy} onClick={() => void refreshStatus()}>刷新状态</Button>
            </div>

            {notice && <Alert type='info' showIcon message={notice} closable onClose={() => setNotice(null)} />}
            {err && <Alert type='error' showIcon message={err} closable onClose={() => setErr(null)} />}
            {memLow && (
                <Alert
                    type='warning' showIcon
                    message={`可用内存 ${st?.mem_available_mb}MB，低于起任务所需的 ${st?.mem_min_mb}MB`}
                    description='建图要起 umap/numba，服务端会直接拒绝启动（硬上会把整站拖垮）。这个阈值是实测线而不是拍的：400 节点的一次真实重建峰值 552MB，取 ~1.16 倍余量（余量故意留小——本机可用内存实测在 699–1070MB 之间晃，余量一大这扇门就常年关着）；换页空间不计入。腾出内存后再点；确有把握时也可以在 agent 的 .env 里写 GRAPH_BUILD_MEM_MIN_MB 改阈值。'
                />
            )}
            {articleCount !== null && articleCount >= PAGE_LIMIT && (
                <Alert
                    type='warning' showIcon
                    message={`取到 ${articleCount} 篇公开文章，正好是列表接口一页的上限`}
                    description={`文章更多时可能被截断（第 ${PAGE_LIMIT + 1} 篇开始进不了图）。图上少几篇不会报错，只是少了——需要的话分批建。`}
                />
            )}

            <div className='grState'>
                <h4>任务状态</h4>
                {!loaded ? (
                    <p className='grMuted'>读取中…</p>
                ) : (
                    <ul className='grMeta'>
                        <li>状态：<Tag color={STATUS_COLOR[status]}>{STATUS_TEXT[status]}</Tag></li>
                        <li>类型：{st?.mode === 'precheck' ? '环境预检' : st?.mode === 'rebuild' ? '重建' : '—'}</li>
                        <li>run：{st?.run_id || '—'}</li>
                        <li>
                            内存：{typeof st?.mem_available_mb === 'number' ? `${st.mem_available_mb} MB` : '—'}
                            {typeof st?.mem_min_mb === 'number' ? ` / 起任务需要 ${st.mem_min_mb} MB` : ''}
                        </li>
                        <li>开始：{st?.started_at || '—'}</li>
                        <li>结束：{st?.ended_at || '—'}{typeof st?.elapsed === 'number' ? `（耗时 ${st.elapsed}s）` : ''}</li>
                        {st?.exit_code !== null && st?.exit_code !== undefined && <li>退出码：{st.exit_code}</li>}
                        {status === 'interrupted' && (
                            <li>
                                中断原因：{st?.stale_reason === 'owner_gone'
                                    ? '属主进程没了（服务被重启过）——直接再点一次开始即可，不需要手工清理'
                                    : '收尾写到一半被打断——直接再点一次开始即可'}
                            </li>
                        )}
                        {st?.cancel_requested && status === 'running' && <li>已收到取消请求，正在等进程退出…</li>}
                    </ul>
                )}
                {st?.error && <Alert type='error' showIcon message={st.error} />}
                {r && (
                    <div className='grResult'>
                        <h4>{st?.mode === 'precheck' ? '预检结果' : '产物'}</h4>
                        {r.deps_ready ? (
                            <p>依赖已就绪（umap / numba / scipy 都能 import）。</p>
                        ) : (
                            <ul className='grMeta'>
                                <li>产物：{r.file || '—'}（{fmtBytes(r.bytes)}）</li>
                                <li>节点 {r.nodes ?? '—'} 个 / 向量 {r.dim ?? '—'} 维</li>
                                <li>版本：{r.build_id || '—'}；生成于 {r.built || '—'}</li>
                                <li>归属站点：{r.site || '（未署名——前台任何站点都会显示这份图）'}</li>
                                <li>{embedText(r)}</li>
                                {r.reload_local === false && (
                                    <li>本进程未热重载（{r.reload_error || '未知原因'}）——其余实例下次查询时会按新版本自动换</li>
                                )}
                            </ul>
                        )}
                        {r.warn && <Alert type='warning' showIcon message={r.warn} />}
                    </div>
                )}
            </div>

            {tail.length > 0 && (
                <div className='grLogWrap'>
                    <h4>日志尾部（最后 {tail.length} 行{st?.log ? `；完整日志：${st.log}` : ''}）</h4>
                    <pre className='grLog' ref={logRef}>{tail.join('\n')}</pre>
                </div>
            )}

            {st?.argv && st.argv.length > 0 && (
                <details className='grArgv'>
                    <summary>这次实际跑的命令</summary>
                    <code>{st.argv.join(' ')}</code>
                </details>
            )}
        </div>
    )
}

export default GraphRebuild
