import { CalendarOutlined, DeleteOutlined, HolderOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import {Calendar, Card, ConfigProvider, Checkbox, DatePicker, Input, Modal, Avatar, Select, Button, message} from "antd";
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
// 「看板娘一轮对话收尾」信号（20260926 起也用在这张卡上）：agent 可能刚往这份列表里
// 追加过一条——常量的定义与派发点见 components/UserCenter/agentTurn.ts。
import {AGENT_TURN_DONE_EVENT} from "../../../components/UserCenter/agentTurn";

type Todo = {id: number, text: string, done: boolean, date?: string};

// 逾期 = 有日期、还没做完、且日期在今天之前
const isOverdue = (t: Todo, today: string) => !!t.date && !t.done && t.date < today;
// （原先还有个 todoClass：给日历格子里那两行待办文字拼 class 用的。格子改成小圆点
// 之后没有消费方了，随「格子里写文字」那条路一起删掉——留着就是死代码。）

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

/** HTML 转义。点名要它是因为签名走的是 typed 的 `contentType: 'html'`（innerHTML 通道），
 *  而签名是站点设置里填的**自由文本** —— 直接把 `<` 递进去等于把它当标签解析。
 *  （同一条教训：20260930 之前看板娘 hitokoto 因 innerHTML 直插未转义被移出 tools 数组。） */
const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c] as string));

const Home = () => {
    //hooks区域
    const typedRef = useRef(null);
    // 欢迎卡那格头像 = **登录用户自己的**（20260930 用户点名"头像不硬编码"）。
    // 原先读的 `state.user.avatar` 是站点设置里那张（谁看都一样）。
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
    // 还有几条留言等着人工裁决（20260924 三轮）。它不是待办：不进 todos、不落库、
    // 不能拖也不能删，只在列表顶上当一个"去处理"的入口。
    // 20260924 四轮：数字改从**未读汇总**（GET /api/protected/notifications/summary）拿。
    // 原来这里自己每 60 秒拉一次整张留言表再数 `approved===0`——为了界面上一行提示
    // 把整张表拉进内存、还多起一条轮询，而那条汇总接口本来就在以同样的节奏被头部
    // 头像的红点读着。现在这一页只是那个 store 的**消费者之一**（`useUnread`），
    // 与红点共用一份读数、一个定时器；切回标签页与 agent 收尾那两条立即刷新的通道
    // 也一并继承（原来这里各写了一遍）。没登录时 store 不发请求、这一行也不画。
    const { counts: unread } = useUnread(true);
    const pendingReview = unread.pendingReview;
    // 等处理的额度重置申请（20260929）：与 pendingReview 完全同族——同一个汇总接口、
    // 同一份读数、同样**不进 total**，只是指向后台另一个页签（`?tab=quota`）。
    const pendingQuota = unread.pendingQuota;
    const navigate = useNavigate();

    const today = dayjs().format('YYYY-MM-DD');
    // agent 也能往这份列表里加一条（20260926）：服务端给它开了一条**只追加**的通道
    // （POST /api/protected/todos/item，见 apis/DashboardMethods.tsx 头注）。麻烦在于
    // 这份界面是**整份**读写：库里多了一条而本地不知道时，下一次自动保存（PUT）就会
    // 把它抹掉。所以 agent 收尾那一刻要重读一次——两个 ref 就是为此：
    //   · `todosRef` 让事件回调读到**此刻**的列表（回调是异步的，闭包里的 todos 是旧值）；
    //   · `pendingReload` 是"本地还有没落库的改动、先别读"的记号（见下面两处消费点）。
    // 在**渲染期**给 ref 赋值而不是放进 effect：effect 要等提交+绘制之后才跑，那个空档
    // 里收到 agent-turn-done 会读到上一版列表——那一版若恰好"干净"，它会当场重读，把主人
    // 刚敲进去的字丢掉（判断错最坏的那一侧）。
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
    // 给某一行排期（或撤掉它的日期）。原先一条待办的日期只有两个来路：日历上点那天
    // 再在快添栏里写、或者一开始就没日期——已经在列表里的那行**改不了**，"新增的任务
    // 不能绑定期限"就是这么来的。现在每行自带一个排期按钮，新建的与已有的都能改。
    const setTodoDate = (id: number, date?: string) => {
        setTodos(prev => prev.map(t => t.id === id ? {...t, date} : t));
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

    // 日历格子：只画小圆点，不写待办文字（20260924 二轮）。
    //
    // 上一轮把待办文字塞进格子，代价是格子必须撑到 46px 以上（整块日历 383px），
    // 而 antd 的「今天」标记是挂在格子上的 1px 描边环（`.ant-picker-cell-inner::before`）——
    // 格子一变成大方块，那圈环就跟着放大成 57×58 的方框、日期数字缩到左上角，
    // 于是"今天"既看不出是几号、标记看着也偏了。现在格子回到 26px 的小圆、
    // 数字居中，标记重新贴着数字；待办改成格子下沿的点：最多 3 个，
    // 未完成紫 / 逾期红 / 已完成灰，鼠标停上去给出那天的待办清单。
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

            <div className='left' style={{height: '100%',width:'25%',display:'flex',flexDirection:'column'}}>
               <div className="about_logo">
                   <div className="about_me">
                       {/* 头像外圈不再写内联 `border`（内联 style 特异性最高，会把 CSS 里
                           那圈动漫风光环压掉）——环与光晕都归 index.sass 管。 */}
                       <Avatar src={avatar} size={130} className="animeAvatar" />
                       {signature && <div ref={typedRef} className="typed"></div>}
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
                                // 头部改成一行装得下的紧凑版（20260924 二轮）：‹ 年月 › 今天。
                                // 原先是「年下拉 + 月下拉 + 今天也要加油呀😀 + 月/年切换」四项挤一行、
                                // 且**没有翻月按钮**（自定义 headerRender 会把 antd 自带的 ‹ › 顶掉，
                                // 只能靠下拉跳月）。现在补上 ‹ ›、加一个「今天」，腾出的位置去掉
                                // 那句鸡汤与 月/年 切换——年视图是另一套 12 格面板，与这套紧凑样式不搭。
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

               {/* 这个 locale 现在罩住整个右栏（20260924 三轮）：原来是只包日历，
                   待办行里的排期小月历在它外面 ⇒ 面板会是英文的。 */}
               <Card className="cardInfo">
                   <Input
                        className="todoTitle"
                        value={listTitle}
                        onChange={(e) => setListTitle(e.target.value)}
                        bordered={false}
                   />
                   <div className="todoBody">
                        {/* 顶上这一行不是待办（不进 todos、不落库、不能拖不能删）：
                            它是"评论管理那边还有几条等我裁决"的入口，审完自然消失 */}
                        {pendingReview > 0 &&
                            <div className="todo-review"
                                 onClick={() => navigate('/dashboard/users?tab=review')}>
                                <span className="todo-review-n">{pendingReview}</span>
                                <span>条评论待人工审核</span>
                                <RightOutlined className="todo-review-go" />
                            </div>}
                        {/* 第二行非待办提示（20260929）：等处理的额度重置申请。与上一行同构
                            （不进 todos、不落库、不能拖不能删），但**类名另起**（`.todo-quota`）
                            ——`.todo-review` 在同一页里必须恒为一条，沙箱那条断言锁着它
                            （dashboard-home.test.py），复用类名会把两种提示数成同一件事。 */}
                        {pendingQuota > 0 &&
                            <div className="todo-quota"
                                 onClick={() => navigate('/dashboard/users?tab=quota')}>
                                <span className="todo-quota-n">{pendingQuota}</span>
                                <span>条额度重置申请待处理</span>
                                <RightOutlined className="todo-quota-go" />
                            </div>}
                        {/* 没读出来之前不显示"还没有待办"——那会把"读失败"说成"你没有待办" */}
                        {!loaded && !loadErr &&
                            <div className="todo-empty">正在读待办…</div>}
                        {loadErr &&
                            <div className="todo-empty todo-loaderr">
                                {loadErr}
                                <Button type="link" size="small"
                                        onClick={() => void loadTodos()}>重试</Button>
                            </div>}
                        {/* 这一句里点名的按钮名要和下面那颗按钮一字不差（沙箱锁着：
                            空列表那一节断言这句里的名字就是按钮上那个） */}
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
                                        {/* 每行自己的排期按钮：没排期只露一枚淡日历图标，
                                            有日期就直接写 M/D；点开是小月历，想改就改、
                                            想撤就按清除。逾期行的日期标红（原来那个只读的
                                            红字 span 就是被它替掉的）。 */}
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
                        {/* 列表没读出来时不让新增：那一刻加的行不在服务端那份里，
                            之后重试读回来就把它冲掉了（比"按钮点了没反应"更让人困惑） */}
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
