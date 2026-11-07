import './index.sass'
import {
    Alert,
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
import zhCNDefault from "antd/lib/locale/zh_CN";
import React, {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {useLocation, useNavigate, useSearchParams} from "react-router-dom";
import {NoteType} from "../../../../interface/NoteType";
import {useDispatch, useSelector} from "react-redux";
import {adminNotesApi} from "../../../../apis/adminNotesApi";
import {ok, errMsg} from "../../../../apis/ProfileMethods";
import {QuestionCircleOutlined, ReloadOutlined} from '@ant-design/icons';
import dayjs from "dayjs";
import {Fab} from "@mui/material";
import DeleteIconDefault from "@mui/icons-material/Delete";
import DeleteForeverIconDefault from "@mui/icons-material/DeleteForever";
import EditIconDefault from "@mui/icons-material/Edit";
import ChangeCircleIconDefault from "@mui/icons-material/ChangeCircle";
import {cjsDefault} from "../../../../utils/cjsDefault";
import {renderNoteTagsCollapsed} from "../../../../apis/TagMethods.tsx";
import {delAllNotes, delNote, updateNoteStatus} from "../../../../apis/NoteMethods.tsx";
import {resolveApiAssetUrl} from "../../../../utils/runtimeApi";
import NoteTagSelect from "../../../../components/NoteTagSelect/index.tsx";
import {joinNoteTags, parseNoteTags} from "../../../../utils/noteTags";
import {useLiveRefresh} from "../../../../utils/liveRefresh.ts";
import {
    DEFAULT_LIST_QUERY,
    PAGE_SIZE_OPTIONS,
    ListQuery,
    ListTab,
    buildListQuery,
    mergeListQuery,
    parseListQuery,
    saveListReturn,
} from "./listState";
const zhCN = cjsDefault(zhCNDefault)
const DeleteIcon = cjsDefault(DeleteIconDefault)
const DeleteForeverIcon = cjsDefault(DeleteForeverIconDefault)
const EditIcon = cjsDefault(EditIconDefault)
const ChangeCircleIcon = cjsDefault(ChangeCircleIconDefault)

function normalizeStatus(status?: string): 'public' | 'private' | 'draft' {
    if (status === 'private') return 'private';
    if (status === 'draft') return 'draft';
    return 'public';   // 'public' / 'published' / 未知一律按公开
}

interface AdvancedSearchFormProps {
    search: string;
    query: ListQuery;
    onSearch: (patch: Partial<ListQuery>) => void;
    onReset: () => void;
}

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

    const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
    const [editRow, setEditRow] = useState<NoteType | null>(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const query = useMemo(() => parseListQuery(location.search), [location.search]);

    const setParam = useCallback((patch: Partial<ListQuery>, options?: {replace?: boolean}) => {
        const next = mergeListQuery(parseListQuery(location.search), patch);
        setSearchParams(buildListQuery(next), {replace: options?.replace});
    }, [location.search, setSearchParams]);

    useEffect(() => {
        saveListReturn(location.search);
    }, [location.search]);

    const result = adminNotesApi.useAdminNotesQuery(query);
    const page = result.currentData;
    const rows = page?.items ?? [];
    const loading = result.isFetching;
    const total = page?.total ?? 0;
    const current = page?.page ?? query.page;
    const pageRows = rows;
    const selectionScope = buildListQuery({...query, page: 1, size: 10});
    useEffect(() => { setSelectedRowKeys([]); }, [selectionScope]);

    const reloadList = (_background: boolean) => result.refetch().then(() => {});
    useLiveRefresh(() => reloadList(true), { skip: () => isModalOpen || !!editRow });
    const refreshNotes = () => dispatch(adminNotesApi.util.invalidateTags(['AdminNotes', 'AdminNoteCount']));

    const tableBoxRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const box = tableBoxRef.current;
        if (box) box.scrollTop = 0;
    }, [current, query.size]);

    const DeleteNote = async (key: React.Key) => {
        try {
            const res = await delNote(Number(key))
            if (ok(res)) {
                refreshNotes();
                message.success('删除成功')
            } else message.error(errMsg(res, '删除失败'))
        } catch {
            message.error('删除失败')
        }
    }

    const deleteAll = async () => {
        try {
            const keys = [...selectedRowKeys];
            const res = await delAllNotes(keys)
            if (ok(res)) {
                refreshNotes();
                setSelectedRowKeys([])
                message.success('删除成功')
            } else message.error(errMsg(res, '删除失败'))
        } catch {
            message.error('删除失败')
        }
    }

    const showModal = (value: NoteType) => {
        setEditRow(value)
    }

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
            if(ok(res)){
                refreshNotes();
                setEditRow(null)
                message.success('文章配置已更新')
            } else message.error(errMsg(res, '配置更新失败'))
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
            render: (cover) => <Image src={resolveApiAssetUrl(cover)} alt="封面缩略图" style={{ width: '100%', maxWidth: 90, height: 56, objectFit: 'cover', borderRadius: 5}} />
        },
        {
            title: '文章标题',
            dataIndex: 'noteTitle',
            key: 'title',
            width: isNarrow ? '45%' : '20%',
            align: "center",
            className: 'note-title-col',
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
        preserveSelectedRowKeys: true,
        onChange: onSelectChange,
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

            {result.isError && <Alert type="error" showIcon message="文章列表加载失败，请重试"
                action={<Button onClick={() => void reloadList(false).catch(() => {})}>重试</Button>}/>}
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
                        locale={{emptyText: result.isError ? "未能读取文章，请重试" : "没有符合条件的文章"}}
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
                            showQuickJumper={total > query.size * 5}
                            showTotal={(t, [a, b]) => `第 ${a}-${b} 条 / 共 ${t} 篇`}
                            onChange={(p, s) => {
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
