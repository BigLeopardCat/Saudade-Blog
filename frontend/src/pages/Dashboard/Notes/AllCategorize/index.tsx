import './index.sass';
import { Alert, Button, ColorPicker, Empty, Form, Grid, Input, message, Modal, Select, Space, Table, Tag } from 'antd';
import type { TableProps } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { Key } from 'react';
import { FolderOpenOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { CategoriesType } from '../../../../interface/CategoriesType';
import { fetchCategories } from '../../../../store/components/categories';
import { useDispatch } from 'react-redux';
import { addCategory, delAllCategory, getCategories, updateCategory } from '../../../../apis/CategoryMethods';
import { useLiveRefresh } from '../../../../utils/liveRefresh';
import { runAdminMutation } from '../../../../utils/adminMutation';

const DEFAULT_COLOR = '#d94f9a';
const ICONS = [
    { value: 'fa-folder-open', name: '文件夹' }, { value: 'fa-book', name: '书籍' },
    { value: 'fa-code', name: '代码' }, { value: 'fa-camera', name: '摄影' },
    { value: 'fa-leaf', name: '生活' }, { value: 'fa-music', name: '音乐' },
    { value: 'fa-plane', name: '旅行' }, { value: 'fa-star', name: '收藏' },
];
const suggestedPath = (name: string) => name.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/[-_]{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '');

export default function AllCategorize() {
    const screens = Grid.useBreakpoint();
    const dispatch = useDispatch();
    const [rows, setRows] = useState<CategoriesType[]>([]);
    const [selectedKeys, setSelectedKeys] = useState<Key[]>([]);
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<CategoriesType | null>(null);
    const [deleting, setDeleting] = useState<CategoriesType[] | null>(null);
    const [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const pathEdited = useRef(false);
    const generation = useRef(0);
    const readInFlight = useRef<Promise<void> | null>(null);
    const [form] = Form.useForm();
    const watchedName = Form.useWatch('categoryTitle', form);
    const watchedIcon = Form.useWatch('icon', form);
    const watchedColor = Form.useWatch('color', form);
    const colorPreview = typeof watchedColor === 'string' ? watchedColor : watchedColor?.toHexString?.();

    function loadCategories() {
        if (readInFlight.current) return readInFlight.current;
        const current = ++generation.current;
        setLoading(true);
        setLoadError(false);
        const promise = getCategories().then(response => {
            if (current !== generation.current) return;
            if (response.status !== 200 || response.data?.code !== 200 || !Array.isArray(response.data.data)) throw new Error('Invalid categories');
            const next: CategoriesType[] = response.data.data.map((item: Omit<CategoriesType, 'categoryKey'> & { categoryKey: number }) => ({ ...item, key: item.categoryKey }));
            setRows(next);
            setSelectedKeys(keys => keys.filter(key => next.some(row => row.key === key)));
        }).catch(() => {
            if (current === generation.current) setLoadError(true);
        }).finally(() => {
            if (current === generation.current) {
                setLoading(false);
                readInFlight.current = null;
            }
        });
        readInFlight.current = promise;
        return promise;
    }
    useEffect(() => {
        void loadCategories();
        return () => { ++generation.current; readInFlight.current = null; };
    }, []);
    useLiveRefresh(loadCategories, { skip: () => open || deleting !== null || busy });

    function refreshAfterWrite() {
        // A list requested before the mutation cannot become its confirmed refreshed state.
        readInFlight.current = null;
        void loadCategories();
        dispatch<any>(fetchCategories());
    }
    function showForm(row: CategoriesType | null = null) {
        if (lock.current) return;
        setEditing(row);
        pathEdited.current = row !== null;
        form.resetFields();
        form.setFieldsValue(row ? {
            categoryTitle: row.categoryTitle, pathName: row.pathName,
            introduce: row.introduce, icon: row.icon || ICONS[0].value, color: row.color || DEFAULT_COLOR,
        } : { categoryTitle: '', pathName: '', introduce: '', icon: ICONS[0].value, color: DEFAULT_COLOR });
        setOpen(true);
    }
    const save = () => runAdminMutation(lock, setBusy, async () => {
        const values = await form.validateFields();
        const payload = {
            categoryTitle: values.categoryTitle.trim(), pathName: values.pathName.trim(),
            introduce: (values.introduce || '').trim(), icon: values.icon,
            color: typeof values.color === 'string' ? values.color : values.color.toHexString(),
        };
        return editing ? updateCategory(payload, editing.key) : addCategory(payload);
    }, () => {
        message.success(editing ? '分类已保存' : '分类已创建');
        setOpen(false);
        form.resetFields();
        refreshAfterWrite();
    }, reason => { message.error(reason); });
    const remove = () => {
        if (!deleting?.length) return;
        const keys = deleting.map(row => row.key);
        return runAdminMutation(lock, setBusy, () => delAllCategory(keys), () => {
            setSelectedKeys(previous => previous.filter(key => !keys.includes(Number(key))));
            setDeleting(null);
            message.success('分类已删除');
            refreshAfterWrite();
        }, reason => { message.error(reason); });
    };
    const closeForm = () => { if (!lock.current) setOpen(false); };
    const keyword = query.trim().toLocaleLowerCase();
    const filtered = rows.filter(row => `${row.categoryTitle} ${row.pathName} ${row.introduce}`.toLocaleLowerCase().includes(keyword));
    const selected = rows.filter(row => selectedKeys.includes(row.key));
    const iconChoices = ICONS.map(icon => ({ value: icon.value, label: <Space><i className={`fa ${icon.value}`} aria-hidden="true" />{icon.name}</Space> }));
    if (editing?.icon && !ICONS.some(icon => icon.value === editing.icon)) {
        iconChoices.push({ value: editing.icon, label: <Space><i className={`fa ${editing.icon}`} aria-hidden="true" />当前图标</Space> });
    }
    const columns: TableProps<CategoriesType>['columns'] = [
        { title: '分类', key: 'category', render: (_, row) => <div className="categoryIdentity">
            <span className="categorySymbol" style={{ color: row.color || DEFAULT_COLOR }}><i className={`fa ${row.icon || ICONS[0].value}`} aria-hidden="true" /></span>
            <div><strong>{row.categoryTitle}</strong><span className="categoryPath">/{row.pathName}</span>{!screens.lg && <small>{row.noteCount} 篇文章</small>}</div>
        </div> },
        { title: '介绍', dataIndex: 'introduce', key: 'introduce', responsive: ['lg'], ellipsis: true },
        { title: '文章', dataIndex: 'noteCount', key: 'noteCount', width: 90, responsive: ['lg'], render: count => `${count} 篇` },
        { title: '操作', key: 'actions', width: screens.lg ? 160 : 120, render: (_, row) => <Space size={0} wrap>
            <Button type="link" disabled={busy} aria-label={`编辑分类 ${row.categoryTitle}`} onClick={() => showForm(row)}>编辑</Button>
            <Button type="text" danger disabled={busy} aria-label={`删除分类 ${row.categoryTitle}`} onClick={() => setDeleting([row])}>删除</Button>
        </Space> },
    ];
    return <section className="catListBox categoryManager" aria-labelledby="category-manager-title">
        <header className="categoryHeading">
            <div><h2 id="category-manager-title"><FolderOpenOutlined aria-hidden="true" /> 分类管理</h2><p>按主题整理文章，设置分类在前台展示的名称与样式。</p></div>
            <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} disabled={busy} onClick={() => showForm()}>新建分类</Button>
        </header>
        <div className="categoryToolbar">
            <Input.Search aria-label="搜索分类" placeholder="搜索名称、路径或介绍" value={query} onChange={event => setQuery(event.target.value)} allowClear />
            <Space><span>共 {rows.length} 个分类</span><Button icon={<ReloadOutlined aria-hidden="true" />} loading={loading} disabled={busy || open || deleting !== null} onClick={() => { void loadCategories(); }}>刷新</Button></Space>
        </div>
        {loadError && <Alert type="error" showIcon message="分类加载失败，已保留现有列表" action={<Button size="small" onClick={() => { void loadCategories(); }}>重试</Button>} />}
        {selected.length > 0 && <div className="categorySelection"><span>已选择 {selected.length} 个分类</span><Space wrap><Button onClick={() => setSelectedKeys([])} disabled={busy}>取消选择</Button><Button danger onClick={() => setDeleting(selected)} disabled={busy}>删除所选分类</Button></Space></div>}
        <Table<CategoriesType> columns={columns} dataSource={filtered} loading={loading} rowKey="key" pagination={{ defaultPageSize: 8, showSizeChanger: true, showTotal: total => `共 ${total} 个分类` }}
            rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys, getCheckboxProps: row => ({ disabled: busy, 'aria-label': `选择分类 ${row.categoryTitle}` }) }}
            locale={{ emptyText: loading || loadError ? '等待加载分类' : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={keyword ? '没有匹配的分类，请调整搜索' : '还没有分类，先创建一个主题吧'} /> }} />
        <Modal title={editing ? `编辑分类 · ${editing.categoryTitle}` : '新建分类'} open={open} onOk={() => { void save(); }} onCancel={closeForm} confirmLoading={busy} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy} okText={editing ? '保存修改' : '创建分类'} cancelText="取消" width={560}>
            <Form form={form} layout="vertical" disabled={busy} onFinish={() => { void save(); }} onValuesChange={changed => {
                if ('pathName' in changed) pathEdited.current = true;
                if ('categoryTitle' in changed && !pathEdited.current) form.setFieldValue('pathName', suggestedPath(changed.categoryTitle));
            }}>
                <Form.Item label="分类名称" name="categoryTitle" rules={[{ required: true, whitespace: true, message: '请填写分类名称' }, { max: 50, message: '名称最多 50 个字符' }, { validator: (_, value) => rows.some(row => row.key !== editing?.key && row.categoryTitle.trim() === value?.trim()) ? Promise.reject(new Error('已有同名分类，请换一个名称')) : Promise.resolve() }]}>
                    <Input placeholder="例如：技术札记、旅行见闻" maxLength={50} showCount />
                </Form.Item>
                <Form.Item label="访问路径" name="pathName" extra="名称会自动生成建议，可自行修改。支持中文、字母、数字、短横线和下划线；编辑已有路径可能使旧链接失效。" rules={[{ required: true, whitespace: true, message: '请填写访问路径' }, { max: 100, message: '路径最多 100 个字符' }, { pattern: /^[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*$/u, message: '请使用中文、字母、数字，以短横线或下划线分隔' }, { validator: (_, value) => rows.some(row => row.key !== editing?.key && row.pathName === value?.trim()) ? Promise.reject(new Error('这个路径已被使用')) : Promise.resolve() }]}>
                    <Input prefix="/category/" placeholder="例如：技术札记 或 tech-notes" />
                </Form.Item>
                <Form.Item label="分类介绍（选填）" name="introduce" extra={editing ? '简要说明收录内容；留空会保留已有介绍。' : '简要说明这个分类收录哪些内容。'} rules={[{ max: 255, message: '介绍最多 255 个字符' }]}>
                    <Input.TextArea placeholder="这个分类收录哪些内容？" rows={3} maxLength={255} showCount />
                </Form.Item>
                <div className="categoryAppearance"><Form.Item label="分类图标" name="icon" rules={[{ required: true, message: '请选择图标' }]}><Select options={iconChoices} /></Form.Item><Form.Item label="主题颜色" name="color"><ColorPicker disabledAlpha showText presets={[{ label: '常用配色', colors: [DEFAULT_COLOR, '#7b61a8', '#4b8f81', '#3975b8', '#c98135', '#c45858'] }]} /></Form.Item></div>
                <div className="categoryPreview" aria-label="分类预览"><span>前台预览</span><Tag color={colorPreview || DEFAULT_COLOR}><i className={`fa ${watchedIcon || ICONS[0].value}`} aria-hidden="true" /> {watchedName || '分类名称'}</Tag></div>
            </Form>
        </Modal>
        <Modal title={deleting?.length === 1 ? `删除分类「${deleting[0].categoryTitle}」？` : `删除 ${deleting?.length || 0} 个分类？`} open={deleting !== null} onOk={() => { void remove(); }} onCancel={() => { if (!lock.current) setDeleting(null); }} confirmLoading={busy} okText="确认删除分类" cancelText="取消" okButtonProps={{ danger: true }} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy}>
            <p>分类删除后无法恢复。文章会保留，原属这些分类的文章将变为未分类。</p>
            <p>当前统计涉及 {deleting?.reduce((count, row) => count + row.noteCount, 0) || 0} 篇文章，请确认是否需要先在文章管理中重新分类。</p>
            <div className="categoryDeleteNames">{deleting?.map(row => <Tag key={row.key}>{row.categoryTitle}</Tag>)}</div>
        </Modal>
    </section>;
}
