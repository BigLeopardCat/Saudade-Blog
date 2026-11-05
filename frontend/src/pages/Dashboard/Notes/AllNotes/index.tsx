import './index.sass'
import {
    Button,
    ConfigProvider,
    Form,
    Grid,
    Image,
    Input,
    message,
    Modal,
    Pagination,
    Popconfirm,
    Radio,
    Select,
    Space,
    Table,
    Tabs,
    Tag,
    theme,
} from 'antd';
import type { TableProps, TabsProps } from 'antd';
// 分页条自己带 locale：`showSizeChanger` 的「10 条/页」「跳至」是 antd 的**内置文案**，
// 不套 locale 会在这里冒出英文（后台壳的 ConfigProvider 只设了 theme，没设 locale）
import zhCNDefault from "antd/lib/locale/zh_CN";
import React, {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {useLocation, useNavigate, useSearchParams} from "react-router-dom";
import {NoteType} from "../../../../interface/NoteType";
import {useDispatch, useSelector} from "react-redux";
import {fetchNoteList} from "../../../../store/components/note.tsx";
import {QuestionCircleOutlined, ReloadOutlined} from '@ant-design/icons';
import dayjs from "dayjs";
import {Fab} from "@mui/material";
import DeleteIconDefault from "@mui/icons-material/Delete";
import DeleteForeverIconDefault from "@mui/icons-material/DeleteForever";
import EditIconDefault from "@mui/icons-material/Edit";
import ChangeCircleIconDefault from "@mui/icons-material/ChangeCircle";
import {cjsDefault} from "../../../../utils/cjsDefault";
import {renderNoteTagsCollapsed} from "../../../../apis/TagMethods.tsx";
import {delAllNotes, delNote, getAdminNotes, searchAdminNotes, updateNoteStatus} from "../../../../apis/NoteMethods.tsx";
import {resolveApiAssetUrl} from "../../../../utils/runtimeApi";
import NoteTagSelect from "../../../../components/NoteTagSelect/index.tsx";
import {joinNoteTags, parseNoteTags} from "../../../../utils/noteTags";
import {useLiveRefresh} from "../../../../utils/liveRefresh.ts";
import {
    DEFAULT_LIST_QUERY,
    LIST_PAGE_SIZE,
    PAGE_SIZE_OPTIONS,
    ListQuery,
    ListTab,
    buildListQuery,
    clampPage,
    filterRowsByTags,
    listRequest,
    mergeListQuery,
    normalizeNoteRows,
    pageSlice,
    parseListQuery,
    patchRow,
    saveListReturn,
} from "./listState";

// antd 的 locale 包与 @mui 的图标包都是 CJS，Vite 8 之后默认 import 拿到的是名字空间对象
// 而不是组件/locale（图标当组件用会 `Element type is invalid … got: object` ＝ React #130；
// locale 只是**静默**退回英文）。判据与三种形态见 utils/cjsDefault.ts。
// **不要改回裸的 default import。**
const zhCN = cjsDefault(zhCNDefault)
const DeleteIcon = cjsDefault(DeleteIconDefault)
const DeleteForeverIcon = cjsDefault(DeleteForeverIconDefault)
const EditIcon = cjsDefault(EditIconDefault)
const ChangeCircleIcon = cjsDefault(ChangeCircleIconDefault)

/**
 * 状态归一：DTO 在 status 为 NULL 时给的是 `"published"`（`map_note` 的兜底），
 * 而单选框只有 公开/私密/草稿 三个值 —— 不归一的话遇到这种行会**三个都不选中**
 * （旧版"弹窗打开是空的"就是这么来的），保存时还会把 undefined 原样发出去。
 */
function normalizeStatus(status?: string): 'public' | 'private' | 'draft' {
    if (status === 'private') return 'private';
    if (status === 'draft') return 'draft';
    return 'public';   // 'public' / 'published' / 未知一律按公开
}

interface AdvancedSearchFormProps {
    /** 原始 query 串。回填 effect 只认这个**字符串**依赖 —— 换成对象会无限重渲染 */
    search: string;
    query: ListQuery;
    onSearch: (patch: Partial<ListQuery>) => void;
    onReset: () => void;
}

/**
 * 搜索表单：**不再自己发请求**，只把条件交给父级写进 URL（唯一真源），
 * 再由取数 effect 统一发。旧版它自己 `setSearchNotes` 塞结果、又和父级的取数 effect
 * 抢同一份 state，切 tab / 翻页时两边互相覆盖。
 */
const AdvancedSearchForm = ({search, query, onSearch, onReset}: AdvancedSearchFormProps) => {
    const { token } = theme.useToken();
    const [form] = Form.useForm();
    const categories = useSelector((state: {categories: any}) => state.categories.categories);

    useEffect(() => {
        form.setFieldsValue({
            title: query.title || undefined,
            categories: query.cat || undefined,
            top: query.top === '' ? undefined : Number(query.top),
            tagsLab: query.tags.length > 0 ? query.tags : undefined,
        });
        // query 由 search 派生，依赖 search 这一个字符串就够（见文件头铁律 2）
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search, form]);

    const onFinish = (values: any) => {
        onSearch({
            title: typeof values.title === 'string' ? values.title.trim() : '',
            cat: values.categories ?? '',
            top: (values.top === undefined || values.top === null) ? '' : String(values.top),
            from: '',
            to: '',
            tags: parseNoteTags(values.tagsLab),
            page: 1,
        });
    };

    // 一行放下：`layout="inline"` 自带换行（窄屏自动折行），不再靠定高 140px 硬撑 ——
    // 原来那条约死的行高一旦少一个控件就在表单底部留一块空白。
    const formStyle: React.CSSProperties = {
        maxWidth: '98%',
        borderRadius: token.borderRadiusLG,
        padding: '18px 24px 0',
        margin: 'auto',
        background: 'transparent',
    };

    return (
        <Form form={form} name="advanced_search" layout="inline" style={formStyle} onFinish={onFinish}>
            <Form.Item name='title' label='文章标题'>
                <Input placeholder="请输入文章标题" allowClear style={{width: 180}} />
            </Form.Item>
            <Form.Item name='categories' label='文章分类'>
                <Select allowClear placeholder="请选择文章分类" style={{width: 160}}>
                    {categories.map((category: { categoryKey?: React.Key; key?: React.Key; categoryTitle: string }) => (
                        <Select.Option key={category.categoryKey ?? category.key} value={category.categoryTitle}>
                            {category.categoryTitle}
                        </Select.Option>
                    ))}
                </Select>
            </Form.Item>
            <Form.Item name='tagsLab' label='文章标签'>
                <NoteTagSelect allowCreate={false} placeholder="请选择文章标签" style={{width: 220}} />
            </Form.Item>
            <Form.Item name='top' label='是否置顶'>
                <Select allowClear placeholder="请选择是否置顶" style={{width: 110}} options={[
                    { value: 1, label: '是' },
                    { value: 0, label: '否' },
                ]}>
                </Select>
            </Form.Item>
            <Form.Item>
                <Space size="small">
                    <Button type="primary" htmlType="submit">
                        搜索
                    </Button>
                    <Button
                        onClick={() => {
                            form.resetFields();
                            onReset();
                        }}
                    >
                        重置
                    </Button>
                </Space>
            </Form.Item>
        </Form>
    );
};

const AllNotes = () => {
    const navigate = useNavigate()
    const location = useLocation()
    const [, setSearchParams] = useSearchParams()
    const dispatch = useDispatch()
    const [form] = Form.useForm();
    const tagList = useSelector((state: {tags: any}) => state.tags.tag)
    const categories = useSelector((state: {categories: any}) => state.categories.categories);

    const [rows, setRows] = useState<NoteType[]>([])
    const [loading, setLoading] = useState(false)
    const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
    /** 行内「文章配置」的目标行。持有**整行**（旧版只存一个 key 字符串，回填无从谈起） */
    const [editRow, setEditRow] = useState<NoteType | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);

    // 页码/tab/搜索条件的唯一真源
    const query = useMemo(() => parseListQuery(location.search), [location.search]);

    /** 唯一的写 URL 出口。默认 push（这样浏览器后退能回上一页），需要时可 replace */
    const setParam = useCallback((patch: Partial<ListQuery>, options?: {replace?: boolean}) => {
        const next = mergeListQuery(parseListQuery(location.search), patch);
        setSearchParams(buildListQuery(next), {replace: options?.replace});
    }, [location.search, setSearchParams]);

    useEffect(() => {
        saveListReturn(location.search);
    }, [location.search]);

    // ② 取数只认「筛选条件 + tab」—— `page: 1` 与 `size: 默认值` 把**分页**排除在 key 之外
    //    （buildListQuery 的默认值不落串，所以第 1 页与第 5 页、每页 10 条与 50 条算出的
    //    key 一模一样），翻页/改每页条数都是纯前端 pageSlice。
    //    行为变化要知道：翻页不再顺带刷新数据，改为切 tab / 改条件 / 重挂载才刷。
    //    ⚠️ 必须是**字符串**（文件头铁律 2）：deps 里放对象会无限重渲染 + 无限请求。
    const fetchKey = useMemo(
        () => buildListQuery({...query, page: 1, size: LIST_PAGE_SIZE}),
        [query],
    );

    // ── 取数：**只读** URL，绝不回写（回写就是 URL→effect→URL 死循环）──────────────
    // `reloadSeq` 是"再来一遍"的序号（跨端同步用，见下面 `useLiveRefresh`）：它进 deps，
    // 于是背景重拉走的就是**这一条**取数路径——条件、竞态守卫、失败提示全都同一份，
    // 不会再长出一条"只把这一页拉对、换个 tab 就拉错"的旁路。
    const [reloadSeq, setReloadSeq] = useState(0);
    const bgReloadRef = useRef(false);   // 这一次重拉是不是背景发起的（决定亮不亮 loading）
    useEffect(() => {
        let alive = true;              // 竞态守卫：切 tab 时慢响应不能盖掉快响应
        const request = listRequest(parseListQuery(fetchKey));
        // 背景重拉（看板娘收尾事件 / 切回可见 / 轮询）**不亮表格的 loading**：后台每 20 秒
        // 抖一下 spinner，会让人以为页面自己在动（同评论管理那一页的理由）。
        const bg = bgReloadRef.current;
        bgReloadRef.current = false;
        setLoading(!bg);
        const pending = request.mode === 'list'
            ? getAdminNotes()
            : searchAdminNotes(request.body);
        pending
            .then((res: any) => {
                if (!alive) return;
                if (res?.status === 200) setRows(normalizeNoteRows(res.data?.data));
            })
            .catch(() => {
                if (alive) {
                    setRows([]);
                    message.error('文章列表加载失败');
                }
            })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [fetchKey, reloadSeq]);

    // 勾选行跟着数据收敛（删掉的行不该继续被勾着）。
    // 只在数据变化时求交：**翻页不清空**（保留跨页勾选），也不放进 effect cleanup
    // 或 setStaticDate 的 updater 里（那两处都会在无关重渲染里误清）。
    useEffect(() => {
        setSelectedRowKeys(prev => {
            if (prev.length === 0) return prev;
            const alive = new Set(rows.map(r => String(r.key)));
            const next = prev.filter(k => alive.has(String(k)));
            return next.length === prev.length ? prev : next;
        });
    }, [rows]);

    /** 重拉一次。`bg` = 背景式（不亮表格 loading，见取数 effect 里的 `bgReloadRef`）：
     *  自动重拉传 true，主人手动点「刷新」传 false——那一下要有"在转"的反馈。 */
    const reloadList = (bg: boolean) => {
        bgReloadRef.current = bg;
        setReloadSeq((n) => n + 1);
    };
    useLiveRefresh(() => reloadList(true), { skip: () => isModalOpen || !!editRow });

    // 标签筛选（前端侧）、分页切片、**渲染期**钳制
    const tagFiltered = useMemo(() => filterRowsByTags(rows, query.tags), [rows, query.tags]);
    const total = tagFiltered.length;
    // 当前页越界时只影响"显示哪一页/切哪几行"，URL 里那个 page 原样不动 ——
    // 一旦在这里回写 URL，就变成死循环；而"改完配置页码跳回第一页"正是钳制结果被
    // 当成真实页码造成的。
    const current = clampPage(query.page, total, query.size);
    const pageRows = useMemo(
        () => pageSlice(tagFiltered, current, query.size),
        [tagFiltered, current, query.size],
    );

    const tableBoxRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const box = tableBoxRef.current;
        if (box) box.scrollTop = 0;
    }, [current, query.size]);

    const DeleteNote = async (key: React.Key) => {
        try {
            const res = await delNote(Number(key))
            if (res.status === 200) {
                // 只摘掉被删的这一行，不整表重拉：重拉会改 total → 触发钳制 → 页码跳页
                setRows(prev => prev.filter(r => r.key !== key));
                dispatch<any>(fetchNoteList(true))
                message.success('删除成功')
            }
        } catch {
            message.error('删除失败')
        }
    }

    const deleteAll = async () => {
        try {
            const keys = [...selectedRowKeys];
            const res = await delAllNotes(keys)
            if (res.status === 200) {
                const removed = new Set(keys);
                setRows(prev => prev.filter(r => !removed.has(r.key)));
                dispatch<any>(fetchNoteList(true))
                setSelectedRowKeys([])
                message.success('删除成功')
            }
        } catch {
            message.error('删除失败')
        }
    }

    const showModal = (value: NoteType) => {
        setEditRow(value)
    }

    // 回填**必须放在 effect 里**：antd v5 的 Modal 首次打开前不渲染 children，
    // 同一帧里调 form.setFieldsValue 会报 "useForm is not connected to any Form element"
    // 并**静默失败** —— 这就是旧版弹窗打开时单选按钮全空的原因。
    // 回填也不只是体验问题：后端对 noteTags 是"传了就写"，不预填就保存会把标签清空。
    useEffect(() => {
        if (!editRow) return;
        form.setFieldsValue({
            status: normalizeStatus(editRow.status),
            top: String(editRow.isTop ?? 0),
            noteTags: parseNoteTags(editRow.noteTags),
        });
    }, [editRow, form]);

    const onOk = async () => {
        const target = editRow;
        if (!target) return;
        let values: any;
        try {
            values = await form.validateFields();
        } catch {
            return;   // 校验失败的提示由 antd 自己弹
        }
        // 与服务端 DTO 同一个格式（`%Y-%m-%d %H:%M:%S`）。
        // 既有显示 bug：这里原来是 `hh`（12 小时制），下午 3 点会显示成 03:00:00。
        const updateTime = dayjs().format('YYYY-MM-DD HH:mm:ss');
        const patch: Partial<NoteType> = {
            isTop: Number(values.top ?? 0),
            status: values.status,
            noteTags: parseNoteTags(values.noteTags),
            updateTime: updateTime as unknown as Date,
        }
        const data = {
            isTop: patch.isTop as number,
            status: patch.status as string,
            noteTags: joinNoteTags(patch.noteTags as number[]),
            updateTime,
        }
        try{
            const res = await updateNoteStatus(data, String(target.key))
            if(res.status === 200){
                // 就地打这一个补丁，**不重拉整表**：重拉会改 total 并触发分页钳制，
                // 用户看到的就是"改完配置页码回到第一页"。
                // 也**不把这行 filter 掉**（状态改了可能不再属于当前 tab）：行在眼皮底下
                // 消失比"它暂时不属于本 tab"更让人迷惑，而且过滤会让 total 变小、同样触发跳页。
                // 同理不再 dispatch(fetchNoteList)：那是公共列表 store 的缓存，本页不消费它，
                // 每次改配置都多打一次 /notes/list 纯属浪费（Dashboard 布局与自己 Home 页
                // 挂载时都会刷它，不会脏）。
                setRows(prev => patchRow(prev, target.key, patch));
                setEditRow(null)
                message.success('文章配置已更新')
            }
        }catch{
            message.error("配置更新失败")
        }
    }

    const onCancel = () => {
        setEditRow(null)
    }

    const showdelModal = () => {
        setIsModalOpen(true);
    };

    const handledelOk = () => {
        deleteAll()
        setIsModalOpen(false);
    };

    const handledelCancel = () => {
        setIsModalOpen(false);
    };

    const screens = Grid.useBreakpoint();
    const isNarrow = !screens.lg;
    const columns: TableProps<NoteType>['columns'] = [
        {
            title: '封面缩略图',
            dataIndex: 'cover',
            key: 'cover',
            width: '7%',
            align: "center",
            responsive: ['lg'],
            // 锁死高度：不锁的话行高随每张封面原图的宽高比跳，几行下去表格就参差不齐
            render: (cover) => <Image src={resolveApiAssetUrl(cover)} alt="封面缩略图" style={{ width: '100%', maxWidth: 90, height: 56, objectFit: 'cover', borderRadius: 5}} />
        },
        {
            title: '文章标题',
            dataIndex: 'noteTitle',
            key: 'title',
            width: isNarrow ? '45%' : '20%',
            align: "center",
            // className 落到 th/td 上，供验证脚本按列定位（别用 td:nth-child —— rowSelection
            // 会插一列，序号会错位）
            className: 'note-title-col',
            // 省略号必须自己写：antd 的 ellipsis 对 flex 子项无效（实测 computed 仍是 clip），
            // 见 index.sass 的 .note-title-cell / .note-title-txt（两处 min-width:0 缺一不可）。
            render: (title: string, record: NoteType) => (
                <div className="note-title-cell">
                    <span className="note-title-txt" title={title}>{title}</span>
                    {record?.draftOf ? <Tag color="orange" style={{marginInlineStart: 0, flex: '0 0 auto'}}>修改稿</Tag> : null}
                </div>
            )
        },
        {
            title: '文章分类',
            dataIndex: 'noteCategory',
            key: 'categories',
            width: '9%',
            align: "center",
            responsive: ['lg'],
            render: (item) => (
                <>
                    {categories
                        .filter((category: { categoryTitle: string;categoryKey:number }) => category.categoryKey === item)
                        .map((category: { color: string | undefined; categoryKey?: React.Key; key?: React.Key; icon: any; categoryTitle: string | number | boolean | React.ReactElement<any, string | React.JSXElementConstructor<any>> | Iterable<React.ReactNode> | React.ReactPortal | null | undefined; }) => (
                            <div className="note-category-cell" key={category.categoryKey ?? category.key}>
                                <Tag color={category.color}>
                                    <Space align={'center'} size={3}>
                                        <i className={`iconfont ${category.icon}`} style={{ display: 'block', fontSize: 18}}></i>
                                        <span>{category.categoryTitle}</span>
                                    </Space>
                                </Tag>
                            </div>

                        ))
                    }
                </>
            )
        },
        {
            title: '文章标签',
            key: 'tags',
            dataIndex: 'tags',
            width: '20%',
            align: "center",
            className: 'note-tags-col',
            responsive: ['lg'],
            render: (_, record) => renderNoteTagsCollapsed(record.noteTags, tagList, 3, record.noteTagRefs),
        },
        {
            title: '是否置顶',
            key: 'isTop',
            dataIndex: 'isTop',
            width: '7%',
            align: "center",
            responsive: ['lg'],
            render: (isTop) => (isTop ? <i className={`iconfont icon-yes`} style={{fontSize:24}}></i> : <i className={`iconfont icon-no`} style={{fontSize:24}}></i>),
        },
        {
            title: '最近更新时间',
            key: 'updateTime',
            dataIndex: 'updateTime',
            width: '12%',
            align: "center",
            responsive: ['lg'],
            // 以前这里写死 width:160 —— 在 fixed 布局里就是个会撑破列的隐患
            render: (time) => <span style={{fontWeight:600, whiteSpace:'nowrap'}}>{time}</span>,
        },
        {
            title: '文章状态',
            key: 'status',
            dataIndex: 'status',
            width: '8%',
            align: "center",
            responsive: ['lg'],
            render: (status) => (status === 'public' ?  <i className={`iconfont icon-public1`}></i> : status === 'private' ? <i className={`iconfont icon-private4`}></i>: status === 'draft' ? <i className={`iconfont icon-caogaoxiang1`}></i>: '未知状态'),
        },
        {
            title: '操作',
            key: 'action',
            width: isNarrow ? '42%' : '12%',
            align: "center",
            render: (item) => (
                <div style={{display: "flex",flexDirection:'row',alignItems:'center',justifyContent:'center'}}>
                    <Fab color="info" aria-label="edit" size='small' style={{marginRight:4}} onClick={() => navigate(`/dashboard/notes/newnote/${item.draftOf ?? item.key}`)}>
                        <EditIcon />
                    </Fab>
                    <Popconfirm
                        title="删除确认"
                        description="永久删除此文章及修改稿、评论和互动记录？图片文件会保留。"
                        icon={<QuestionCircleOutlined style={{ color: 'red' }} />}
                        okText='删除'
                        onConfirm={() => DeleteNote(item.key)}
                        cancelText='取消'
                    >
                        <Fab color="error" aria-label="edit" size='small' style={{marginRight:4}}>
                            <DeleteIcon />
                        </Fab>
                    </Popconfirm>
                    <Fab color="secondary" aria-label="config" size='small' onClick={() => showModal(item)}>
                        <ChangeCircleIcon />
                    </Fab>
                </div>
            ),
        },
    ];
    const onSelectChange = (newSelectedRowKeys: React.Key[]) => {
        setSelectedRowKeys(newSelectedRowKeys);
    };

    const rowSelection = {
        selectedRowKeys,
        onChange: onSelectChange,
        /** 勾选列宽固定声明，让百分比列宽合计能留出对应余量 */
        columnWidth: 32,
    };
    const hasSelected = selectedRowKeys.length > 0;

    const items: TabsProps['items'] = [
        {
            label: '公开文章',
            key: '4',
        },
        {
            label: '全部文章',
            key: '1',
        },
        {
            label: '私密文章',
            key: '2',
        },
        {
            label: '草稿箱',
            key: '3',
        },
    ];

    return <>
        <div className="AllCard">
            <AdvancedSearchForm
                search={location.search}
                query={query}
                onSearch={(patch) => setParam(patch)}
                onReset={() => setParam({
                    ...DEFAULT_LIST_QUERY,
                    tab: query.tab,   // 「重置」只清搜索条件，不动 tab —— tab 是另一个控件
                })}
            />
            {hasSelected&&<Fab variant="extended" color='error' size='medium' style={{marginLeft:15,marginTop:15}} onClick={showdelModal}>
                <DeleteForeverIcon sx={{ mr: 1 }} className='allin'/>
                批量删除
            </Fab>}

            <div className="searchRes">
                <Tabs
                    activeKey={query.tab}
                    items={items}
                    style={{marginLeft: 10}}
                    tabBarExtraContent={{
                        left: (
                            <>
                                <Button type="primary" size="small"
                                        style={{marginRight: 12}}
                                        onClick={() => navigate('/dashboard/notes/newnote')}>
                                    新增文章
                                </Button>
                                <Button size="small" icon={<ReloadOutlined />}
                                        style={{marginRight: 12}}
                                        onClick={() => reloadList(false)}>
                                    刷新
                                </Button>
                            </>
                        ),
                    }}
                    // onChange 里原来那一大坨分支（各自发请求、还顺手 filter 一遍本地数据）
                    // 全部删掉：切 tab 只是改 URL，取数由 effect 统一做。
                    onChange={(value) => setParam({tab: value as ListTab, page: 1})}
                />
                <div className='custom-scroll-container' ref={tableBoxRef}>
                    <Table
                        columns={columns}
                        dataSource={pageRows}
                        loading={loading}
                        rowSelection={rowSelection}
                        tableLayout="fixed"
                        pagination={false}
                        // 改完配置的行**留在原地**（不 filter 掉，见 onOk 的说明）；如果它
                        // 因此不再属于当前 tab，就把它压暗提示一下，而不是让它凭空消失。
                        rowClassName={(record) => {
                            if (query.tab === '2' && record.status !== 'private') return 'note-row-off-tab';
                            if (query.tab === '3' && record.status !== 'draft') return 'note-row-off-tab';
                            return '';
                        }}
                    />
                </div>
                <div className="listFooter">
                    <ConfigProvider locale={zhCN}>
                        <Pagination
                            size="small"
                            current={current}
                            pageSize={query.size}
                            total={total}
                            showSizeChanger
                            pageSizeOptions={PAGE_SIZE_OPTIONS}
                            // 页数少的时候"跳至"是噪声，多于 5 页才给
                            showQuickJumper={total > query.size * 5}
                            showTotal={(t, [a, b]) => `第 ${a}-${b} 条 / 共 ${t} 篇`}
                            onChange={(p, s) => {
                                // 改每页条数 = 换一套分页：页码回第 1 页（否则会停在
                                // "新分页里其实只有 1 页"的越界位置，靠 clampPage 兜也行，
                                // 但那样 URL 里的 page 与实际显示的不一致）
                                if (s !== query.size) setParam({size: s, page: 1});
                                else setParam({page: p});
                            }}
                        />
                    </ConfigProvider>
                </div>
            </div>
        </div>

        <Modal
            open={editRow !== null}
            title="文章配置"
            okText="保存"
            cancelText="取消"
            onCancel={onCancel}
            onOk={onOk}
        >
            {editRow && (
                <div style={{marginBottom: 12, opacity: .75, wordBreak: 'break-all'}}>
                    {editRow.noteTitle}
                </div>
            )}
            <Form
                form={form}
                layout="vertical"
                name="changeStatue"
            >

                <Form.Item name="status" className="collection-create-form_last-form-item" label={<h4>文章状态</h4>}>
                    <Radio.Group>
                        <Radio value="public">公开</Radio>
                        <Radio value="private">私密</Radio>
                        <Radio value="draft">草稿</Radio>
                    </Radio.Group>
                </Form.Item>

                <Form.Item name="top" label={<h4>是否置顶</h4>}>
                    <Radio.Group>
                        <Radio value="1">是</Radio>
                        <Radio value="0">否</Radio>
                    </Radio.Group>
                </Form.Item>

                <Form.Item name="noteTags" label={<h4>文章标签</h4>}>
                    <NoteTagSelect />
                </Form.Item>
            </Form>
        </Modal>

        <Modal title="删除确认" open={isModalOpen} onOk={handledelOk} onCancel={handledelCancel}  okText="确定" cancelText="取消">
            永久删除所选文章及修改稿、评论和互动记录？图片文件会保留。
        </Modal>
    </>
}
export default AllNotes;
