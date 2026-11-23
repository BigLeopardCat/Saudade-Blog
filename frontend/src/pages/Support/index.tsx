import {useState, type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {t, useLocale} from '../../i18n';
import {useAuthToken} from '../../utils/useAuthToken';
import {useRead, useWrite, type Action, type CaseKind, type Detail, type Entry, type Page, type Status, type Ticket, type Topic} from './api';
import './support.css';

const states: Record<Status, string> = {waiting_staff: '待客服回复', waiting_user: '待用户回复', resolved: '已解决'};
const kinds: Record<CaseKind, string> = {question: '问题咨询', ticket: '工单'};
const actions: Record<Entry['action'], string> = {
    open_question: '发起咨询', open_ticket: '提交工单', reply: '回复', escalate: '转为工单', resolve: '标记已解决', reopen: '重新打开',
};
const date = (value: string, locale: string) => new Date(value).toLocaleString(locale);

function Knowledge() {
    const [filter, setFilter] = useState('');
    const [revision, refresh] = useState(0);
    const topics = useRead<Topic[]>('/api/public/support/topics', null, revision);
    const matches = topics?.data?.filter(topic => (t(topic.question) + t(topic.answer)).toLowerCase().includes(filter.trim().toLowerCase()));
    return <section className="support-panel" aria-labelledby="support-faq"><h2 id="support-faq">{t('常见问题')}</h2>
        <input type="search" aria-label={t('搜索常见问题')} placeholder={t('搜索常见问题')} value={filter} onChange={e => setFilter(e.target.value)}/>
        {topics?.error && <p role="alert">{t(topics.error)} <button onClick={() => refresh(r => r+1)}>{t('重试')}</button></p>}
        {!topics && <p role="status">{t('加载中')}</p>}
        {matches?.map(topic => <details key={topic.id}><summary>{t(topic.question)}</summary><p>{t(topic.answer)}</p>
            {topic.href !== '/support' && <Link to={topic.href}>{t('前往相关页面')}</Link>}</details>)}
        {matches?.length === 0 && <p>{t('没有匹配的问题，可以提交咨询。')}</p>}
    </section>;
}

function Compose({token, base, done, cancel}: {token: string; base: string; done: (id: number) => void; cancel: () => void}) {
    const [kind, setKind] = useState<CaseKind>('question');
    const [subject, setSubject] = useState('');
    const [body, setBody] = useState('');
    const write = useWrite(token);
    async function submit(e: FormEvent) {
        e.preventDefault();
        const item = await write.send(base, {kind, subject: subject.trim(), body: body.trim()});
        if (item) done(item.id);
    }
    return <form className="support-panel support-form" onSubmit={submit}><h2>{t('新建咨询或工单')}</h2>
        <label>{t('类型')}<select value={kind} onChange={e => setKind(e.target.value as CaseKind)}>
            <option value="question">{t(kinds.question)}</option><option value="ticket">{t(kinds.ticket)}</option></select></label>
        <label>{t('主题')}<input required maxLength={120} value={subject} onChange={e => setSubject(e.target.value)}/></label>
        <label>{t('问题描述')}<textarea required maxLength={4000} rows={5} value={body} onChange={e => setBody(e.target.value)}/></label>
        {write.error && <p role="alert">{t(write.error)}</p>}
        <div className="support-actions"><button className="support-primary" disabled={write.busy || !body.trim() || !subject.trim()}>{t('提交')}</button>
            <button type="button" disabled={write.busy} onClick={cancel}>{t('取消')}</button></div>
    </form>;
}

function Thread({token, base, id, back}: {token: string; base: string; id: number; back: () => void}) {
    const locale = useLocale();
    const [revision, refresh] = useState(0);
    const [before, setBefore] = useState<number | null>(null);
    const [reply, setReply] = useState('');
    const result = useRead<Detail>(base + '/' + id + (before ? '?before=' + before : ''), token, revision, before === null);
    const write = useWrite(token);
    const record = result?.data?.case;
    const latest = () => {setBefore(null); refresh(r => r+1);};
    async function submit(action: Action) {
        if (!record) return;
        const item = await write.send(base + '/' + id + '/events', {action, version: record.version, body: action === 'reply' ? reply.trim() : ''}, latest);
        if (item) { if (action === 'reply') setReply(''); latest(); }
    }
    return <section className="support-panel"><div className="support-actions"><button onClick={back}>{t('返回列表')}</button><button onClick={latest}>{t('刷新记录')}</button></div>
        {!result && <p role="status">{t('加载中')}</p>}{result?.error && <p role="alert">{t(result.error)}</p>}
        {record && result?.data && <><h2>#{record.id} {record.subject}</h2><p>{t(kinds[record.kind])} · {t(states[record.status])}</p>
            <div className="support-actions">{result.data.events.nextBefore && <button onClick={() => setBefore(result.data!.events.nextBefore)}>{t('更早的记录')}</button>}
                {before && <button onClick={latest}>{t('返回最新记录')}</button>}</div>
            <ol className="support-events">{result.data.events.items.map(event => <li key={event.id}>
                <div><strong>{t(event.sender === 'staff' ? '站点客服' : '用户')}</strong> · {t(actions[event.action])} <time dateTime={event.createdAt}>{date(event.createdAt, locale)}</time></div>
                {event.body && <p>{event.body}</p>}</li>)}</ol>
            {!before && result.data.guidance && <aside className="support-guidance" aria-label={t('首次咨询参考')}>
                <strong>{t('Lunima 客服助手')}</strong>
                {result.data.guidance.topic ? <><p>{t(result.data.guidance.topic.answer)}</p>
                    {result.data.guidance.topic.href !== '/support' && <Link to={result.data.guidance.topic.href}>{t('前往相关页面')}</Link>}</>
                    : <p>{t('未匹配到公开解答，已转人工跟进。')}</p>}
            </aside>}
            {!before && <><div className="support-actions">
                {record.status !== 'resolved' && record.kind === 'question' && <button disabled={write.busy} onClick={() => void submit('escalate')}>{t(actions.escalate)}</button>}
                <button disabled={write.busy} onClick={() => void submit(record.status === 'resolved' ? 'reopen' : 'resolve')}>{t(record.status === 'resolved' ? actions.reopen : actions.resolve)}</button>
            </div>{record.status !== 'resolved' && <form className="support-form" onSubmit={e => {e.preventDefault(); void submit('reply');}}>
                <label>{t('回复内容')}<textarea required rows={3} maxLength={4000} value={reply} onChange={e => setReply(e.target.value)}/></label>
                <button className="support-primary" disabled={write.busy || !reply.trim()}>{t('发送回复')}</button></form>}</>}
        </>}{write.error && <p role="alert">{t(write.error)}</p>}
    </section>;
}

function Desk({staff, token}: {staff: boolean; token: string}) {
    const locale = useLocale();
    const base = staff ? '/api/protected/admin/support/cases' : '/api/protected/support/cases';
    const [selected, select] = useState<number | null>(null);
    const [compose, setCompose] = useState(false);
    const [status, setStatus] = useState('');
    const [cursors, setCursors] = useState<number[]>([]);
    const [revision, refresh] = useState(0);
    const before = cursors[cursors.length - 1];
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (before) query.set('before', String(before));
    const result = useRead<Page<Ticket>>(base + '?' + query, token, revision);
    if (selected) return <Thread key={selected} token={token} base={base} id={selected} back={() => {select(null); refresh(r => r+1);}}/>;
    if (compose) return <Compose token={token} base={base} done={id => {setCompose(false); select(id);}} cancel={() => setCompose(false)}/>;
    return <section className="support-panel"><h2>{t(staff ? '客服队列' : '我的咨询与工单')}</h2>
        <div className="support-actions">{!staff && <button className="support-primary" onClick={() => setCompose(true)}>{t('新建咨询或工单')}</button>}
            <select aria-label={t('按状态筛选')} value={status} onChange={e => {setStatus(e.target.value); setCursors([]);}}>
                <option value="">{t('全部状态')}</option>{Object.entries(states).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select>
            <button onClick={() => refresh(r => r+1)}>{t('刷新')}</button></div>
        {!result && <p role="status">{t('加载中')}</p>}{result?.error && <p role="alert">{t(result.error)}</p>}
        {result?.data?.items.length === 0 && <p>{t('暂无记录')}</p>}
        <ul className="support-list">{result?.data?.items.map(row => <li key={row.id}><button onClick={() => select(row.id)}>
            <strong>#{row.id} {row.subject}</strong><span>{t(kinds[row.kind])} · {t(states[row.status])} · {date(row.updatedAt, locale)}</span></button></li>)}</ul>
        <div className="support-actions">{before && <button onClick={() => setCursors(v => v.slice(0,-1))}>{t('上一页')}</button>}
            {result?.data?.nextBefore && <button onClick={() => setCursors(v => [...v, result.data!.nextBefore!])}>{t('下一页')}</button>}</div>
    </section>;
}

export default function Support({staff = false}: {staff?: boolean}) {
    useLocale();
    const token = useAuthToken();
    return <main className={'support-center' + (staff ? ' support-admin' : '')}><h1>{t(staff ? '客服工作台' : '客服中心')}</h1>
        {!staff && <Knowledge/>}
        {token ? <Desk key={token} token={token} staff={staff}/> : <section className="support-panel"><h2>{t('我的咨询与工单')}</h2>
            <Link to="/login?returnTo=support">{t('请先登录')}</Link></section>}
    </main>;
}
