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
import {fetchNoteList} from "../../../store/components/note.tsx";
import {getTodos, saveTodos, ok, errMsg} from "../../../apis/DashboardMethods.tsx";
import {useNavigate} from "react-router-dom";
import type {DashboardTodo} from "../../../interface/DashboardType";
import {fetchCategories} from "../../../store/components/categories.tsx";
import {fetchTags} from "../../../store/components/tags.tsx";
import {useUnread} from "../../../components/UserCenter/unread";
import {AGENT_TURN_DONE_EVENT} from "../../../components/UserCenter/agentTurn";

// antd 的 locale 包是 CJS，Vite 8 之后默认 import 拿到的是名字空间对象而不是那份 locale
// （antd 读不到内置文案就**静默**退回英文，不报错、不崩）。判据与三种形态见
// utils/cjsDefault.ts。**不要改回 `import zhCN from "antd/lib/locale/zh_CN"`。**
const zhCN = cjsDefault(zhCNDefault)

type Todo = {id: number, text: string, done: boolean, date?: string};

// 逾期 = 有日期、还没做完、且日期在今天之前
const isOverdue = (t: Todo, today: string) => !!t.date && !t.done && t.date < today;

// 本地列表 → 发往服务端的那份（线上口径 {text, done, date}）：
// 空行是前端的临时态（「新建日程」里还没写字），**不发也不存**——服务端同样会跳过。
// 放在模块作用域（不是组件里）：它没有状态，也就没有闭包过期的问题。
const toPayload = (list: Todo[]): DashboardTodo[] =>
    list.filter(t => t.text.trim())
        .map(t => ({text: t.text.trim(), done: t.done, date: t.date ?? null}));

// 本地行号（React 的 key）——服务端不认行 id，这只是"新加的行排在哪"。
const nextId = (list: Todo[]) => (list.length ? Math.max(...list.map(t => t.id)) : 0) + 1;

// 一行的判等键（正文 + 排期）。分隔符用 `\u0000`：它是文本里不会出现的字符，
// 拼接不会把两条不同的行拼成同一个键（"ab" + "c" 与 "a" + "bc" 那种撞键）。
const rowKey = (r: {text: string; date?: string | null}) =>
    r.text.trim() + '\u0000' + (r.date ?? '');

/** 把**库里新多出来的行**（agent 用追加通道写进去的）并进本地列表。
 *
 * 判据 = 「库里现在有」而「上一次与库里同步时有的那份」里没有（`snapshot` = 那次
 * 同步的 payload），**不是**「库里现在有、本地没有」：主人删掉的行是只在本地没了的，
 * 拿本地当判据会把它当成"别人新加的"复活回来——主人删掉的东西自己冒回列表，比一时
 * 看不到 agent 新加的那条糟糕得多。差集只朝"新出现的"这一个方向取，这一点就成立。
 *
 * 没有任何新行时**原样返回 `local`**（同一个引用）：调用方靠这个引用判"要不要多绕
 * 一圈 setState"，见下面保存 effect 里的用法。
 */
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
    //hooks区域
    const typedRef = useRef(null);
    const avatar = useViewerProfile().avatar;
    // 个性签名：站点设置 → `web_info.userTalk` → `GET /api/public/user` → redux `talk`。
    // 以前这里写死「遇事不决可问春风 / 春风不语即随本心」——那是某一位部署者的口味，
    // 不该长在仓库里（同 A3/A4 的处置）。**空签名就整块不渲染**，不拿别的话顶上。
    const signature = useSelector((state: { user: UserState }) => state.user.talk || '').trim();
    const dispatch = useDispatch();

    // Init Data for Analytics
    useEffect(() => {
        dispatch<any>(fetchNoteList(true));
        dispatch<any>(fetchCategories());
        dispatch<any>(fetchTags());
    }, [dispatch]);

    // Toggle List State
    // 卡片标题仍存在本机（`dashboard_list_title`）——它是这块面板的显示名，
    // 不跟着账号走；待办本身已落库（见下）。
    const [listTitle, setListTitle] = useState(() => localStorage.getItem('dashboard_list_title') || '开发进度');
    const [todos, setTodos] = useState<Todo[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [loadErr, setLoadErr] = useState('');
    // 库里"此刻的样子"的指纹：与它一致的本地状态不触发写（读一次不会立刻写回去）
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

    // 读一次：库里的整份列表（按位次）。读失败就如实说、给个重试，不假装"没有待办"。
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

    // agent 收尾 → 重读一次（它可能刚用追加通道记了一条日程）。
    // **本地干净才读**：本地还有没落库的改动（600ms 防抖窗口内）时直接重读会把主人
    // 刚敲的字丢掉，所以那一刻只留记号——等那份改动真要发上去之前，先 GET 一次把
    // agent 加的行并进来再发（见下面的保存 effect）。记号不会一直挂着：本地改动一旦
    // 与库一致（保存成功、或主人自己撤回去了），保存 effect 里那条分支会把它销掉并重读。
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

    // 待审评论数的刷新时机、失败语义、去重都在 unread.ts 那个 store 里（别在这儿再写一遍）：
    // 读失败保持上一次的数（一个提示不该因为一次网络抖动就自己消失），真审完了读回来是 0，
    // 这一行自然就不画了。

    // 每次改动 → 整份发上去（600ms 防抖；不做行级 diff，服务端也不认行 id）。
    // 失败不回滚本地编辑（主人刚敲的字不该被悄悄撤掉），提示一句即可：
    // 下一次改动会把整份重新发上去。
    useEffect(() => {
        if (!loaded) return;
        const rows = toPayload(todos);
        const payload = JSON.stringify(rows);
        if (payload === lastSaved.current) {
            // 本地与库一致（主人的改动被撤回去了/刚保存完），而 agent 在这中间加过一条：
            // 此刻是**安全**的读时机，把它读出来显示，记号销掉。
            if (pendingReload.current) {
                pendingReload.current = false;
                void loadTodos();
            }
            return;
        }
        const timer = setTimeout(async () => {
            if (pendingReload.current) {
                // agent 加过一条、而本地还有没发上去的改动：**先读、再并、再发**。
                // 直接发手上这份就是整份覆盖语义下的删除——agent 那条会被抹掉。
                const res0 = await getTodos();
                if (!ok(res0)) {
                    // 读不到就**不发**：这一次发出去有确定的删除风险（抹掉 agent 那条），
                    // 而本地改动留在手里只是"晚一点保存"（同既有的失败语义：下一次改动
                    // 会把整份重新发上去，记号也还在，下次会再试一遍）。
                    message.error(errMsg(res0, '待办没保存上（没能先跟服务端核对一次）'));
                    return;
                }
                const snapshot = JSON.parse(lastSaved.current || '[]') as DashboardTodo[];
                const merged = mergeServerRows(res0.data?.data ?? [], todos, snapshot);
                pendingReload.current = false;
                if (merged !== todos) {
                    // 真并进来了新行：把并完的列表放回状态，让这个 effect 再跑一遍去保存
                    // （状态是唯一真源——在这里顺手自己发一次请求，会让"界面上的列表"与
                    // "已发出去的那份"变成两个来源，下次保存又得对账一遍）。
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
    // 「新建日程」：先落一条空行并让它自动聚焦；失焦时仍为空就自动收掉，不留空壳
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
    // 拖拽排序。只在同一分组内换位——跨组拖等于顺带改日期，那是另一个动作，
    // 这里不做（宁可不动，也不要"拖过去日期没变、看着又跳回原组"的怪状态）。
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

    // 分组：逾期的那几天并成一组排最前（标红），今天一组，之后按日期升序，没日期的垫底
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
    // 拖拽时"这条属于哪一组"（跨组不接）
    const groupOf = useMemo(() => {
        const m = new Map<number, string>();
        groups.forEach(g => g.items.forEach(t => m.set(t.id, g.key)));
        return m;
    }, [groups]);

    // Calendar Logic
    const onSelectDate = (value: Dayjs) => {
        setPendingDate(value.format('YYYY-MM-DD'));
        setDraft('');
    };
    const commitQuickAdd = () => {
        if (!draft.trim() || !pendingDate) return;
        addTodo(draft, pendingDate);
        setDraft('');   // 快添栏留着不关，方便连着加第二条
    };

    // 点了日历上某一天 → 待办卡里若有那天的分组，就把它带到视野里。
    // 只滚不改数据：点日期的主语义仍是"给这天加一条"（下面那条快添栏），
    // 这里只是让"那天都有什么"不用自己翻。
    //
    // 锚点用的是分组自己的 key，而**已经逾期的那几天在卡里是并成一组的**（key='overdue'，
    // 见上面的 groups）——所以过去的日期要落到 'overdue' 上；直接拿 ISO 日期去找
    // 会一个也匹配不上（点红点那天什么都不会发生）。
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
        // 点最多三个：先显示要紧的（逾期 → 未完成 → 已完成）
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


    //初次渲染
    // **依赖签名本身**：`talk` 是 `/api/public/user` 异步取回来的，挂载那一帧还是空串；
    // 写成 `[]` 会让 typed 拿着空签名初始化（等于这块永远是空的）。
    useEffect(() => {
        if (!signature || !typedRef.current) return;
        const options = {
            // 换行当换行用（签名是主人自己填的一段文本，允许分行）
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
                                    // monthsShort 的返回类型是 dayjs 的 MonthNames 联合（单月时是
                                    // 字符串，但类型没这么窄），String() 一下省去一处 as
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
                                                // 让拖影是整行而不是那个小图标。setDragImage 只在
                                                // 真实拖拽里可用，合成的 DragEvent 会抛
                                                // InvalidStateError —— 抛了也不能带崩拖拽本身。
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
