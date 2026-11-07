import { CalendarOutlined, DeleteOutlined, HolderOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import {Calendar, Card, ConfigProvider, Checkbox, DatePicker, Input, Modal, Avatar, Select, Button, message} from "antd";
import dayjs from "dayjs";
import localeData from "dayjs/plugin/localeData";
dayjs.extend(localeData);
import './index.sass';
import {useCallback, useContext, useEffect, useMemo, useRef, useState} from "react";
import {Dayjs} from "dayjs";
import 'dayjs/locale/zh-cn';
dayjs.locale('zh-cn');
import zhCNDefault from "antd/lib/locale/zh_CN";
import {cjsDefault} from "../../../utils/cjsDefault";
import ArticleRecord from "../../../components/articleRecord";
import ArticleAnalytics from "../../../components/articleAnalytics";
import Typed from 'typed.js';
import { useViewerProfile } from '../../../components/UserCenter/identity';
import MainContext from "../../../components/conText.tsx";
import {useDispatch, useSelector} from "react-redux";
import UserState from "../../../interface/UserState";
import {getTodos, saveTodos, ok, errMsg} from "../../../apis/DashboardMethods.tsx";
import {useNavigate} from "react-router-dom";
import type {DashboardTodo} from "../../../interface/DashboardType";
import {fetchCategories} from "../../../store/components/categories.tsx";
import {fetchTags} from "../../../store/components/tags.tsx";
import {useUnread} from "../../../components/UserCenter/unread";
import {AGENT_TURN_DONE_EVENT} from "../../../components/UserCenter/agentTurn";
const zhCN = cjsDefault(zhCNDefault)

type Todo = {id: number, text: string, done: boolean, date?: string};
const isOverdue = (t: Todo, today: string) => !!t.date && !t.done && t.date < today;
const toPayload = (list: Todo[]): DashboardTodo[] =>
    list.filter(t => t.text.trim())
        .map(t => ({text: t.text.trim(), done: t.done, date: t.date ?? null}));
const nextId = (list: Todo[]) => (list.length ? Math.max(...list.map(t => t.id)) : 0) + 1;
const rowKey = (r: {text: string; date?: string | null}) =>
    r.text.trim() + '\u0000' + (r.date ?? '');

const mergeServerRows = (server: DashboardTodo[], local: Todo[],
                         snapshot: DashboardTodo[]): Todo[] => {
    const had = new Set(snapshot.map(rowKey));
    const mine = new Set(local.filter(t => t.text.trim()).map(rowKey));
    const fresh = server.filter(r => !had.has(rowKey(r)) && !mine.has(rowKey(r)));
    if (!fresh.length) return local;
    let id = nextId(local);
    return [...local, ...fresh.map(r => ({
        id: id++, text: r.text, done: !!r.done, date: r.date || undefined,
    }))];
};

const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c] as string));

const Home = () => {
    const [modal, modalContext] = Modal.useModal();
    const typedRef = useRef(null);
    const avatar = useViewerProfile().avatar;
    const signature = useSelector((state: { user: UserState }) => state.user.talk || '').trim();
    const dispatch = useDispatch();
    useEffect(() => {
        dispatch<any>(fetchCategories());
        dispatch<any>(fetchTags());
    }, [dispatch]);
    const [listTitle, setListTitle] = useState(() => localStorage.getItem('dashboard_list_title') || '开发进度');
    const [todos, setTodos] = useState<Todo[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [loadErr, setLoadErr] = useState('');
    const lastSaved = useRef('');
    const [pendingDate, setPendingDate] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [focusId, setFocusId] = useState<number | null>(null);   // 刚新增的空行，挂载后自动聚焦
    const [dragId, setDragId] = useState<number | null>(null);
    const { counts: unread } = useUnread(true);
    const pendingReview = unread.pendingReview;
    const pendingQuota = unread.pendingQuota;
    const pendingComments = unread.pendingComments;
    const navigate = useNavigate();

    const today = dayjs().format('YYYY-MM-DD');
    const todosRef = useRef<Todo[]>(todos);
    todosRef.current = todos;
    const pendingReload = useRef(false);
    const loadTodos = useCallback(async () => {
        setLoadErr('');
        const res = await getTodos();
        if (!ok(res)) {
            setLoadErr(errMsg(res, '待办没能读出来'));
            return;
        }
        const rows: Todo[] = (res.data?.data ?? []).map((r, i) => ({
            id: i + 1,                       // 本地行号只是 React 的 key，不发给服务端
            text: r.text,
            done: !!r.done,
            date: r.date || undefined,
        }));
        lastSaved.current = JSON.stringify(toPayload(rows));
        setTodos(rows);
        setLoaded(true);
    }, []);

    useEffect(() => { void loadTodos(); }, [loadTodos]);
    useEffect(() => {
        const onTurnDone = () => {
            if (JSON.stringify(toPayload(todosRef.current)) !== lastSaved.current) {
                pendingReload.current = true;
                return;
            }
            void loadTodos();
        };
        window.addEventListener(AGENT_TURN_DONE_EVENT, onTurnDone);
        return () => window.removeEventListener(AGENT_TURN_DONE_EVENT, onTurnDone);
    }, [loadTodos]);
    useEffect(() => {
        if (!loaded) return;
        const rows = toPayload(todos);
        const payload = JSON.stringify(rows);
        if (payload === lastSaved.current) {
            if (pendingReload.current) {
                pendingReload.current = false;
                void loadTodos();
            }
            return;
        }
        const timer = setTimeout(async () => {
            if (pendingReload.current) {
                const res0 = await getTodos();
                if (!ok(res0)) {
                    message.error(errMsg(res0, '待办没保存上（没能先跟服务端核对一次）'));
                    return;
                }
                const snapshot = JSON.parse(lastSaved.current || '[]') as DashboardTodo[];
                const merged = mergeServerRows(res0.data?.data ?? [], todos, snapshot);
                pendingReload.current = false;
                if (merged !== todos) {
                    setTodos(merged);
                    return;
                }
            }
            const res = await saveTodos(rows);
            if (ok(res)) lastSaved.current = payload;
            else message.error(errMsg(res, '待办没保存上'));
        }, 600);
        return () => clearTimeout(timer);
    }, [todos, loaded, loadTodos]);

    useEffect(() => {
        localStorage.setItem('dashboard_list_title', listTitle);
    }, [listTitle]);

    const toggleTodo = (id: number) => {
        setTodos(prev => prev.map(t => t.id === id ? {...t, done: !t.done} : t));
    };

    const deleteTodo = (id: number) => { setTodos(prev => prev.filter(t => t.id !== id)); };
    const updateTodo = (id: number, text: string) => {
        setTodos(prev => prev.map(t => t.id === id ? {...t, text} : t));
    };
    const setTodoDate = (id: number, date?: string) => {
        setTodos(prev => prev.map(t => t.id === id ? {...t, date} : t));
    };
    const confirmDelete = (todo: Todo) => {
        modal.confirm({
            title: '删掉这条待办？',
            content: todo.text || '（空行）',
            okText: '删除',
            cancelText: '取消',
            okButtonProps: {danger: true},
            onOk: () => deleteTodo(todo.id),
        });
    };
    const addTodo = (text: string, date?: string) => {
        const text2 = text.trim();
        if (!text2) return;
        setTodos(prev => [...prev, {id: nextId(prev), text: text2, done: false, date}]);
    };
    const addBlankRow = () => {
        setTodos(prev => {
            const id = nextId(prev);
            setFocusId(id);
            return [...prev, {id, text: '', done: false}];
        });
    };
    const dropIfEmpty = (todo: Todo) => {
        if (!todo.text.trim()) deleteTodo(todo.id);
    };
    const moveTodo = (fromId: number, toId: number) => {
        if (fromId === toId) return;
        setTodos(prev => {
            const arr = [...prev];
            const from = arr.findIndex(t => t.id === fromId);
            const to = arr.findIndex(t => t.id === toId);
            if (from < 0 || to < 0) return prev;
            const [moved] = arr.splice(from, 1);
            arr.splice(to, 0, moved);
            return arr;
        });
    };
    const groups = useMemo(() => {
        const byDate = new Map<string, Todo[]>();
        const noDate: Todo[] = [];
        for (const t of todos) {
            if (!t.date) { noDate.push(t); continue; }
            const arr = byDate.get(t.date);
            if (arr) arr.push(t); else byDate.set(t.date, [t]);
        }
        const dates = [...byDate.keys()].sort();
        const out: {key: string, label: string, items: Todo[], overdue?: boolean}[] = [];
        const late = dates.filter(d => d < today);
        if (late.length) {
            out.push({key: 'overdue', label: '已逾期', overdue: true,
                      items: late.flatMap(d => byDate.get(d)!)});
        }
        if (byDate.has(today)) out.push({key: today, label: '今天', items: byDate.get(today)!});
        dates.filter(d => d > today).forEach(d => out.push({
            key: d, label: dayjs(d).locale('zh-cn').format('M月D日 dddd'), items: byDate.get(d)!,
        }));
        if (noDate.length) out.push({key: 'none', label: '未排期', items: noDate});
        return out;
    }, [todos, today]);
    const groupOf = useMemo(() => {
        const m = new Map<number, string>();
        groups.forEach(g => g.items.forEach(t => m.set(t.id, g.key)));
        return m;
    }, [groups]);
    const onSelectDate = (value: Dayjs) => {
        setPendingDate(value.format('YYYY-MM-DD'));
        setDraft('');
    };
    const commitQuickAdd = () => {
        if (!draft.trim() || !pendingDate) return;
        addTodo(draft, pendingDate);
        setDraft('');   // 快添栏留着不关，方便连着加第二条
    };

    useEffect(() => {
        if (!pendingDate) return;
        const key = pendingDate < today ? 'overdue' : pendingDate;
        const el = document.querySelector(`.cardInfo .todo-group[data-date="${key}"]`);
        el?.scrollIntoView({ block: 'nearest' });
    }, [pendingDate, today]);

    const dateDotRender = (value: Dayjs) => {
        const dateStr = value.format('YYYY-MM-DD');
        const list = todos.filter(t => t.date === dateStr);
        if (!list.length) return null;
        const rank = (t: Todo) => (isOverdue(t, today) ? 0 : t.done ? 2 : 1);
        const dots = [...list].sort((a, b) => rank(a) - rank(b)).slice(0, 3);
        return (
            <span className="calDots" title={list.map(t => t.text).join('、')}>
                {dots.map(t => (
                    <i key={t.id}
                       className={'calDot' + (isOverdue(t, today) ? ' is-overdue' : t.done ? ' is-done' : '')} />
                ))}
            </span>
        );
    };
    useEffect(() => {
        if (!signature || !typedRef.current) return;
        const options = {
            strings: [escapeHtml(signature).replace(/\n/g, '<br>')],
            typeSpeed: 60,
            backSpeed: 0,
            showCursor: false,
            cursorChar: '|',
            contentType: 'html',
        };

        const typedInstance = new Typed(typedRef.current, options);
        return () => {
            typedInstance.destroy();
        };
    }, [signature]);

    const isDark = useContext(MainContext) === 'true'
        return (
        <div className="home">
            {modalContext}

            <div className='left'>
               <div className="about_logo">
                   <div className="about_me">
                       <Avatar src={avatar} size={130} className="animeAvatar" />
                       {signature && <div ref={typedRef} className="typed"></div>}
                   </div>
               </div>
               <ArticleAnalytics />
           </div>

            <div className='center' style={{paddingRight:30, paddingTop: 50}}>
                <ArticleRecord isDark={isDark}/>
            </div>


            <div className='right'>
               <ConfigProvider locale={zhCN}>
                   <div className="calWrap">
                       <Calendar
                            fullscreen={false}
                            onSelect={onSelectDate}
                            cellRender={dateDotRender}
                            headerRender={({ value, onChange }) => {
                                const months: string[] = [];
                                const localeData = value.localeData();
                                for (let i = 0; i < 12; i++) {
                                    months.push(String(localeData.monthsShort(value.month(i))));
                                }
                                const year = value.year();
                                const month = value.month();
                                const years = [];
                                for (let i = year - 10; i < year + 10; i += 1) {
                                    years.push(
                                        <Select.Option key={i} value={i} className="year-item">
                                            {i}
                                        </Select.Option>,
                                    );
                                }
                                return (
                                    <div className="calHead">
                                        <div className="calHead-left">
                                            <Button className="calNav" size="small" type="text"
                                                    aria-label="上个月"
                                                    icon={<LeftOutlined />}
                                                    onClick={() => onChange(value.clone().add(-1, 'month'))} />
                                            <Select
                                                size="small"
                                                popupMatchSelectWidth={false}
                                                className="my-year-select"
                                                value={year}
                                                onChange={(newYear) => {
                                                    onChange(value.clone().year(newYear));
                                                }}
                                            >
                                                {years}
                                            </Select>
                                            <Select
                                                size="small"
                                                popupMatchSelectWidth={false}
                                                value={month}
                                                onChange={(newMonth) => {
                                                    onChange(value.clone().month(newMonth));
                                                }}
                                            >
                                                {months.map((m, i) => (
                                                    <Select.Option key={i} value={i} className="month-item">
                                                        {m}
                                                    </Select.Option>
                                                ))}
                                            </Select>
                                            <Button className="calNav" size="small" type="text"
                                                    aria-label="下个月"
                                                    icon={<RightOutlined />}
                                                    onClick={() => onChange(value.clone().add(1, 'month'))} />
                                        </div>
                                        <Button className="calToday" size="small" type="text"
                                                onClick={() => onChange(dayjs())}>今天</Button>
                                    </div>
                                );
                            }}
                       />
                       {pendingDate &&
                           <div className="calQuick">
                               <span className="calQuick-label">
                                   {dayjs(pendingDate).locale('zh-cn').format('M月D日')} · 加一条
                               </span>
                               <Input
                                   size="small"
                                   value={draft}
                                   autoFocus
                                   placeholder="写点什么…"
                                   onChange={(e) => setDraft(e.target.value)}
                                   onPressEnter={commitQuickAdd}
                               />
                               <Button size="small" type="primary" onClick={commitQuickAdd}>添加</Button>
                               <Button size="small" type="text"
                                       onClick={() => { setPendingDate(null); setDraft(''); }}>取消</Button>
                           </div>
                       }
                   </div>

               <Card className="cardInfo">
                   <Input
                        className="todoTitle"
                        value={listTitle}
                        onChange={(e) => setListTitle(e.target.value)}
                        bordered={false}
                   />
                   <div className="todoBody">
                        {pendingReview > 0 &&
                            <div className="todo-review"
                                 onClick={() => navigate('/dashboard/users?tab=review')}>
                                <span className="todo-review-n">{pendingReview}</span>
                                <span>条留言待人工审核</span>
                                <RightOutlined className="todo-review-go" />
                            </div>}
                        {pendingQuota > 0 &&
                            <div className="todo-quota"
                                 onClick={() => navigate('/dashboard/users?tab=quota')}>
                                <span className="todo-quota-n">{pendingQuota}</span>
                                <span>条额度重置申请待处理</span>
                                <RightOutlined className="todo-quota-go" />
                            </div>}
                        {pendingComments > 0 &&
                            <div className="todo-comments"
                                 onClick={() => navigate('/dashboard/users?tab=comment')}>
                                <span className="todo-comments-n">{pendingComments}</span>
                                <span>条评论待人工审核</span>
                                <RightOutlined className="todo-comments-go" />
                            </div>}
                        {!loaded && !loadErr &&
                            <div className="todo-empty">正在读待办…</div>}
                        {loadErr &&
                            <div className="todo-empty todo-loaderr">
                                {loadErr}
                                <Button type="link" size="small"
                                        onClick={() => void loadTodos()}>重试</Button>
                            </div>}
                        {loaded && groups.length === 0 &&
                            <div className="todo-empty">还没有待办，点下面的「新建日程」</div>}
                        {groups.map(g => (
                            <div className="todo-group" key={g.key} data-date={g.key}>
                                <div className={'todo-group-head' + (g.overdue ? ' is-overdue' : '')}>
                                    <span>{g.label}</span>
                                    <span className="todo-group-n">{g.items.length}</span>
                                </div>
                                {g.items.map(todo => (
                                    <div
                                        key={todo.id}
                                        className={'todo-row' + (dragId === todo.id ? ' dragging' : '')}
                                        onDragOver={(e) => {
                                            if (dragId !== null && groupOf.get(dragId) === g.key) e.preventDefault();
                                        }}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            if (dragId !== null) moveTodo(dragId, todo.id);
                                            setDragId(null);
                                        }}
                                    >
                                        <HolderOutlined
                                            className="todo-grip"
                                            draggable
                                            onDragStart={(e) => {
                                                const row = (e.currentTarget as HTMLElement).closest('.todo-row');
                                                try {
                                                    if (row) e.dataTransfer.setDragImage(row, 20, 20);
                                                } catch { /* 合成事件：没有拖影可设 */ }
                                                setDragId(todo.id);
                                            }}
                                            onDragEnd={() => setDragId(null)}
                                        />
                                        <Checkbox checked={todo.done} onChange={() => toggleTodo(todo.id)} />
                                        <Input.TextArea
                                            className={'todo-text' + (todo.done ? ' done' : '')}
                                            value={todo.text}
                                            autoFocus={todo.id === focusId}
                                            onChange={(e) => updateTodo(todo.id, e.target.value)}
                                            onBlur={() => dropIfEmpty(todo)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') e.preventDefault();
                                            }}
                                            autoSize={{minRows: 1}}
                                            variant="borderless"
                                            placeholder="写点什么…"
                                        />
                                        <DatePicker
                                            className={'todo-due' + (g.overdue ? ' is-overdue' : '')}
                                            value={todo.date ? dayjs(todo.date) : null}
                                            onChange={(d) => setTodoDate(todo.id, d ? d.format('YYYY-MM-DD') : undefined)}
                                            format="M/D"
                                            size="small"
                                            variant="borderless"
                                            inputReadOnly
                                            placeholder=""
                                            allowClear
                                            suffixIcon={todo.date ? null : <CalendarOutlined className="todo-due-add" />}
                                        />

                                        <DeleteOutlined className="todo-del"
                                                        onClick={() => confirmDelete(todo)} />
                                    </div>
                                ))}
                            </div>
                        ))}
                        <Button className="todo-add" type="dashed" block size="small"
                                disabled={!loaded}
                                onClick={addBlankRow}>新建日程</Button>
                   </div>
               </Card>
               </ConfigProvider>
           </div>
        </div>
    );

};

export default Home;
