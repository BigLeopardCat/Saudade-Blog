import { DeleteOutlined, HolderOutlined, PlusOutlined } from '@ant-design/icons';
import {Calendar, Card, ConfigProvider, Checkbox, Input, Modal, Avatar, Select, Radio, Button, message} from "antd";
import dayjs from "dayjs";
import localeData from "dayjs/plugin/localeData";
dayjs.extend(localeData);
import './index.sass';
import {useCallback, useContext, useEffect, useMemo, useRef, useState} from "react";
import {Dayjs} from "dayjs";
import 'dayjs/locale/zh-cn';
// 只 import 不会把中文设为默认语言：日历头那个月份下拉读的是 dayjs 的全局语言，
// 不设就一直是英文缩写（Sep / Oct）。全站只有中文，直接设成默认（20260924）。
dayjs.locale('zh-cn');
import zhCN from "antd/lib/locale/zh_CN";
import ArticleRecord from "../../../components/articleRecord";
import TheYearPass from "../../../components/theYearPass";
import ArticleAnalytics from "../../../components/articleAnalytics";
import Typed from 'typed.js';
import MainContext from "../../../components/conText.tsx";
import {useDispatch, useSelector} from "react-redux";
import UserState from "../../../interface/UserState";
import {fetchNoteList} from "../../../store/components/note.tsx";
import {getTodos, saveTodos, ok, errMsg} from "../../../apis/DashboardMethods.tsx";
import type {DashboardTodo} from "../../../interface/DashboardType";
import {fetchCategories} from "../../../store/components/categories.tsx";
import {fetchTags} from "../../../store/components/tags.tsx";

type Todo = {id: number, text: string, done: boolean, date?: string};

// 逾期 = 有日期、还没做完、且日期在今天之前
const isOverdue = (t: Todo, today: string) => !!t.date && !t.done && t.date < today;
const todoClass = (t: Todo, today: string) =>
    'todo-item' + (t.done ? ' todo-done' : isOverdue(t, today) ? ' todo-overdue' : '');

// 本地列表 → 发往服务端的那份（线上口径 {text, done, date}）：
// 空行是前端的临时态（"新增一行"里还没写字），**不发也不存**——服务端同样会跳过。
// 放在模块作用域（不是组件里）：它没有状态，也就没有闭包过期的问题。
const toPayload = (list: Todo[]): DashboardTodo[] =>
    list.filter(t => t.text.trim())
        .map(t => ({text: t.text.trim(), done: t.done, date: t.date ?? null}));

const Home = () => {
    //hooks区域
    const typedRef = useRef(null);
    const avatar = useSelector((state: { user: UserState }) => state.user.avatar);
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
    // 待办落库（20260924）：整份列表存服务端（GET/PUT /api/protected/todos），
    // 不再存 localStorage——之前换浏览器/换设备就看不见了。
    // `loaded` 是**安全闸**：列表没读出来之前绝不出网（PUT 发的是整份列表，
    // 空数组的含义就是"清空"，一读失败就写回去等于把主人的待办抹了）。
    const [todos, setTodos] = useState<Todo[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [loadErr, setLoadErr] = useState('');
    // 库里"此刻的样子"的指纹：与它一致的本地状态不触发写（读一次不会立刻写回去）
    const lastSaved = useRef('');
    // 日历下方那条"给某一天加一条"的快添栏。原来点日期弹的是英文 Modal.confirm
    // （「Select Date: 2026-09-24」「添加日程到便签?」），且加出来的是一条
    // 文案被写死成「[日期] 新日程」的待办——20260924 改成直接在日历里输入。
    const [pendingDate, setPendingDate] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [focusId, setFocusId] = useState<number | null>(null);   // 刚新增的空行，挂载后自动聚焦
    const [dragId, setDragId] = useState<number | null>(null);

    const today = dayjs().format('YYYY-MM-DD');
    const nextId = (list: Todo[]) => (list.length ? Math.max(...list.map(t => t.id)) : 0) + 1;

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

    // 每次改动 → 整份发上去（600ms 防抖；不做行级 diff，服务端也不认行 id）。
    // 失败不回滚本地编辑（主人刚敲的字不该被悄悄撤掉），提示一句即可：
    // 下一次改动会把整份重新发上去。
    useEffect(() => {
        if (!loaded) return;
        const rows = toPayload(todos);
        const payload = JSON.stringify(rows);
        if (payload === lastSaved.current) return;
        const timer = setTimeout(async () => {
            const res = await saveTodos(rows);
            if (ok(res)) lastSaved.current = payload;
            else message.error(errMsg(res, '待办没保存上'));
        }, 600);
        return () => clearTimeout(timer);
    }, [todos, loaded]);

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
    // 删除不可逆，先问一句（原先点一下红垃圾桶就没了）
    const confirmDelete = (todo: Todo) => {
        Modal.confirm({
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
    // 「新增一行」：先落一条空行并让它自动聚焦；失焦时仍为空就自动收掉，不留空壳
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

    // 日历格子：直接把待办文字写进格子里（最多两条，多的折成「+N 条」）。
    // 已完成划掉变灰、逾期标红——扫一眼就知道哪天有事、哪天欠着。
    const dateCellRender = (value: Dayjs) => {
        const dateStr = value.format('YYYY-MM-DD');
        const list = todos.filter(t => t.date === dateStr);
        if (!list.length) return null;
        const shown = list.slice(0, 2);
        return (
            <ul className="events">
                {shown.map(item => (
                    <li key={item.id} className={todoClass(item, today)} title={item.text}>
                        {item.text}
                    </li>
                ))}
                {list.length > shown.length &&
                    <li className="events-more">+{list.length - shown.length} 条</li>}
            </ul>
        );
    };


    //初次渲染
    useEffect(() => {
        const options = {
            strings: ['"遇事不决,<br>&nbsp;可问春风“','"春风不语,<br>&nbsp;即随本心“'],
            typeSpeed: 50,
            backSpeed: 50,
            showCursor: false,
            cursorChar: '|',
            contentType: 'html',
        };

        const typedInstance = new Typed(typedRef.current, options);
        return () => {
            typedInstance.destroy();
        };
    }, []);

    const isDark = useContext(MainContext) === 'true'
        return (
        <div className="home">

            <div className='left' style={{height: '100%',width:'25%',display:'flex',flexDirection:'column'}}>
               <div className="about_logo">
                   <div className="about_me">
                       <Avatar src={avatar} size={130} style={{ border: "2px solid #b7b7b7" }} />
                       <div ref={typedRef} className="typed"></div>
                   </div>
                   {/* 三个 CPU/内存/磁盘 表盘已删（20260923）：percent 是写死的常量，
                       不接任何真实指标 —— 假仪表比没有仪表更误导。 */}
               </div>
               {/* Updated to include WordCloud inside ArticleAnalytics */}
               <ArticleAnalytics />
           </div>

            <div className='center' style={{height: '100%',width:'60%',paddingRight:30, paddingTop: 50}}>
                <ArticleRecord isDark={isDark}/>
            </div>


            <div className='right'>
               {/* 每日箴言卡已撤（20260924）：文案取自第三方接口 api.xygeng.cn，
                   既不可控也不属于本站，且它占着右栏最高的那一段（30%）——
                   撤掉正好把日历顶上来。随之删掉的还有 .oneSay 与 .dot 两组
                   只服务这张卡的样式。 */}
               <ConfigProvider locale={zhCN}>
                   <div className="calWrap">
                       <TheYearPass/>
                       <Calendar
                            fullscreen={false}
                            onSelect={onSelectDate}
                            cellRender={dateCellRender}
                            headerRender={({ value, type, onChange, onTypeChange }) => {
                                const start = 0;
                                const end = 12;
                                const monthOptions = [];

                                const localeData = value.localeData();
                                const months = [];
                                for (let i = 0; i < 12; i++) {
                                    months.push(localeData.monthsShort(value.month(i)));
                                }

                                for (let i = start; i < end; i++) {
                                    monthOptions.push(
                                        <Select.Option key={i} value={i} className="month-item">
                                            {months[i]}
                                        </Select.Option>,
                                    );
                                }

                                const year = value.year();
                                const month = value.month();
                                const options = [];
                                for (let i = year - 10; i < year + 10; i += 1) {
                                    options.push(
                                        <Select.Option key={i} value={i} className="year-item">
                                            {i}
                                        </Select.Option>,
                                    );
                                }
                                return (
                                    <div className="calHead">
                                        <div className="calHead-left">
                                            <Select
                                                size="small"
                                                popupMatchSelectWidth={false}
                                                className="my-year-select"
                                                value={year}
                                                onChange={(newYear) => {
                                                    const now = value.clone().year(newYear);
                                                    onChange(now);
                                                }}
                                            >
                                                {options}
                                            </Select>
                                            <Select
                                                size="small"
                                                popupMatchSelectWidth={false}
                                                value={month}
                                                onChange={(newMonth) => {
                                                    const now = value.clone().month(newMonth);
                                                    onChange(now);
                                                }}
                                            >
                                                {monthOptions}
                                            </Select>
                                        </div>
                                        
                                        <div className="calHead-tip">
                                           今天也要加油呀😀
                                        </div>

                                        <Radio.Group
                                            size="small"
                                            onChange={(e) => onTypeChange(e.target.value)}
                                            value={type}
                                        >
                                            <Radio.Button value="month">月</Radio.Button>
                                            <Radio.Button value="year">年</Radio.Button>
                                        </Radio.Group>
                                    </div>
                                );
                            }}
                       />
                       {/* 点某一天之后，快添栏就贴在日历下沿出现（中文、就地输入） */}
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
               </ConfigProvider>

               <Card className="cardInfo">
                   <Input
                        className="todoTitle"
                        value={listTitle}
                        onChange={(e) => setListTitle(e.target.value)}
                        bordered={false}
                   />
                   <div className="todoBody">
                        {/* 没读出来之前不显示"还没有待办"——那会把"读失败"说成"你没有待办" */}
                        {!loaded && !loadErr &&
                            <div className="todo-empty">正在读待办…</div>}
                        {loadErr &&
                            <div className="todo-empty todo-loaderr">
                                {loadErr}
                                <Button type="link" size="small"
                                        onClick={() => void loadTodos()}>重试</Button>
                            </div>}
                        {loaded && groups.length === 0 &&
                            <div className="todo-empty">还没有待办，点下面的「新增一行」</div>}
                        {groups.map(g => (
                            <div className="todo-group" key={g.key}>
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
                                        {/* 拖拽把手单独拿（不给整行挂 draggable）：行里是输入框，
                                            整行可拖会跟"选中一段文字"抢同一个右键手势 */}
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
                                        <Input
                                            className={'todo-text' + (todo.done ? ' done' : '')}
                                            value={todo.text}
                                            autoFocus={todo.id === focusId}
                                            onChange={(e) => updateTodo(todo.id, e.target.value)}
                                            onBlur={() => dropIfEmpty(todo)}
                                            bordered={false}
                                            placeholder="写点什么…"
                                        />
                                        {g.overdue && todo.date &&
                                            <span className="todo-date">{dayjs(todo.date).format('M/D')}</span>}
                                        <DeleteOutlined className="todo-del"
                                                        onClick={() => confirmDelete(todo)} />
                                    </div>
                                ))}
                            </div>
                        ))}
                        {/* 列表没读出来时不让新增：那一刻加的行不在服务端那份里，
                            之后重试读回来就把它冲掉了（比"按钮点了没反应"更让人困惑） */}
                        <Button className="todo-add" type="dashed" block size="small"
                                disabled={!loaded}
                                icon={<PlusOutlined />} onClick={addBlankRow}>新增一行</Button>
                   </div>
               </Card>
           </div>
        </div>
    );

};

export default Home;
