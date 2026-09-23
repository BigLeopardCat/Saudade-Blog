import { DeleteOutlined } from '@ant-design/icons';
import {Calendar, Card, ConfigProvider, Checkbox, Input, Badge, Modal, Avatar, Select, Radio} from "antd";
import dayjs from "dayjs";
import localeData from "dayjs/plugin/localeData";
dayjs.extend(localeData);
import './index.sass';
import {useContext, useEffect, useRef, useState} from "react";
import {Dayjs} from "dayjs";
import 'dayjs/locale/zh-cn';
import zhCN from "antd/lib/locale/zh_CN";
import ArticleRecord from "../../../components/articleRecord";
import TheYearPass from "../../../components/theYearPass";
import ArticleAnalytics from "../../../components/articleAnalytics";
import Typed from 'typed.js';
import MainContext from "../../../components/conText.tsx";
import {useDispatch, useSelector} from "react-redux";
import UserState from "../../../interface/UserState";
import {fetchNoteList} from "../../../store/components/note.tsx";
import {fetchCategories} from "../../../store/components/categories.tsx";
import {fetchTags} from "../../../store/components/tags.tsx";

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
    const [listTitle, setListTitle] = useState(() => localStorage.getItem('dashboard_list_title') || '开发进度');
    const [todos, setTodos] = useState<{id: number, text: string, done: boolean, date?: string}[]>(() => {
        const saved = localStorage.getItem('dashboard_todos');
        return saved ? JSON.parse(saved) : [
             {id: 1, text: '登录逻辑和后台页面UI', done: true},
             {id: 2, text: '静态数据完成后台功能逻辑', done: true},
             {id: 3, text: '后端接口开发', done: false},
        ];
    });

    useEffect(() => {
        localStorage.setItem('dashboard_todos', JSON.stringify(todos));
    }, [todos]);

    useEffect(() => {
        localStorage.setItem('dashboard_list_title', listTitle);
    }, [listTitle]);

    const toggleTodo = (id: number) => {
        setTodos(todos.map(t => t.id === id ? {...t, done: !t.done} : t));
    };

    const deleteTodo = (id: number) => { setTodos(todos.filter(t => t.id !== id)); };
    const updateTodo = (id: number, text: string) => {
        setTodos(todos.map(t => t.id === id ? {...t, text} : t));
    };

    // Calendar Logic
    const onSelectDate = (value: Dayjs) => {
        const dateStr = value.format('YYYY-MM-DD');
        Modal.confirm({
            title: `Select Date: ${dateStr}`,
            content: '添加日程到便签?',
            okText: '添加',
            cancelText: '取消',
            onOk: () => {
                const newId = todos.length > 0 ? Math.max(...todos.map(t => t.id)) + 1 : 1;
                setTodos([...todos, {id: newId, text: `[${dateStr}] 新日程`, done: false, date: dateStr}]);
            }
        });
    };
    
    const dateCellRender = (value: Dayjs) => {
        const dateStr = value.format('YYYY-MM-DD');
        const listData = todos.filter(t => t.date === dateStr);
        return (
            <ul className="events" style={{listStyle: 'none', padding: 0, margin: 0}}>
                {listData.map(item => (
                    <li key={item.id}>
                        <Badge status={item.done ? 'success' : 'warning'} />
                    </li>
                ))}
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
                   </div>
               </ConfigProvider>

               <Card className="cardInfo">
                   <Input 
                        value={listTitle} 
                        onChange={(e) => setListTitle(e.target.value)} 
                        bordered={false} 
                        style={{
                            fontSize: '1.17em', 
                            fontWeight: 'bold', 
                            marginLeft: 0, 
                            marginBottom: 10, 
                            marginTop: 5,
                            paddingLeft: 10
                        }} 
                   />
                   <div style={{display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 10}}>
                        {todos.map(todo => (
                            <div key={todo.id} style={{display: 'flex', alignItems: 'center', gap: 5}}>
                                <Checkbox checked={todo.done} onChange={() => toggleTodo(todo.id)} />
                                <Input 
                                   value={todo.text} 
                                   onChange={(e) => updateTodo(todo.id, e.target.value)} 
                                   bordered={false} 
                                   style={{
                                       textDecoration: todo.done ? 'line-through' : 'none', 
                                       color: todo.done ? 'gray' : 'inherit',
                                       background: 'transparent',
                                       padding: 0
                                   }}
                                />
                                <DeleteOutlined onClick={() => deleteTodo(todo.id)} style={{cursor: 'pointer', color: 'red', marginLeft: '5px'}} />
                            </div>
                        ))}
                   </div>
               </Card>
           </div>
        </div>
    );

};

export default Home;
