import './inedx.sass';
import { Alert, Button, ColorPicker, Empty, Form, Input, Modal, Select, Space, Spin, Tag, Tree, message } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Key } from 'react';
import { PlusOutlined, ReloadOutlined, TagsOutlined } from '@ant-design/icons';
import { useDispatch } from 'react-redux';
import { fetchTags } from '../../../../store/components/tags';
import { addTagOne, addTagTwo, delTag, updateTagOne, updateTagTwo } from '../../../../apis/TagMethods';
import { ok, errMsg } from '../../../../apis/ProfileMethods';
import { useLiveRefresh } from '../../../../utils/liveRefresh';
import { loadTags } from './loadTags';
import type { TagLevelOne } from '../../../../interface/TagType';

type Node = { key: string; id: number; level: 'one' | 'two'; title: string; color: string; parentId?: number; children?: Node[] };
type Mode = { kind: 'create'; level: 'one' | 'two' } | { kind: 'edit'; node: Node };
type Fields = { title: string; fatherTag?: number; color?: string | { toHexString(): string } };
const DEFAULT_COLOR = '#a36b94';
const nodesFrom = (list: TagLevelOne[]): Node[] => list.map(one => ({
    key: `one-${one.key}`, id: Number(one.key), level: 'one', title: one.title, color: one.color,
    children: (one.children || []).map(two => ({ key: `two-${two.key}`, id: Number(two.key), level: 'two', title: two.title, color: two.color, parentId: Number(one.key) })),
}));

export default function AllTag() {
    const [form] = Form.useForm<Fields>();
    const dispatch = useDispatch();
    const [data, setData] = useState<Node[]>([]);
    const [mode, setMode] = useState<Mode>({ kind: 'create', level: 'one' });
    const [checked, setChecked] = useState<Key[]>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [loadError, setLoadError] = useState('');
    const [deleteOpen, setDeleteOpen] = useState(false);
    const busyRef = useRef(false);
    const generation = useRef(0);
    const allNodes = useMemo(() => data.flatMap(one => [one, ...(one.children || [])]), [data]);
    const selected = mode.kind === 'edit' ? allNodes.find(node => node.key === mode.node.key) : undefined;
    const missing = mode.kind === 'edit' && !selected;
    const level = mode.kind === 'edit' ? mode.node.level : mode.level;
    const parentId = Form.useWatch('fatherTag', form);

    async function refresh() {
        const request = ++generation.current;
        try {
            const tree = await loadTags();
            if (request === generation.current) { setData(nodesFrom(tree)); setLoadError(''); }
        } catch {
            if (request === generation.current) setLoadError('标签加载失败，请刷新重试');
        } finally {
            if (request === generation.current) setLoading(false);
        }
    }
    useEffect(() => {
        void refresh();
        return () => { generation.current += 1; };
    }, []);
    useLiveRefresh(refresh, { skip: () => busyRef.current });

    function create(level: 'one' | 'two', fatherTag?: number) {
        if (busyRef.current) return;
        setMode({ kind: 'create', level });
        setError('');
        form.resetFields();
        form.setFieldsValue({ title: '', fatherTag, color: data.find(node => node.id === fatherTag)?.color || DEFAULT_COLOR });
    }
    function edit(key: Key) {
        if (busyRef.current) return;
        const node = allNodes.find(item => item.key === key);
        if (!node) return;
        setMode({ kind: 'edit', node });
        setError('');
        form.setFieldsValue({ title: node.title, fatherTag: node.parentId, color: node.color || DEFAULT_COLOR });
    }
    function syncGlobal() {
        // Redux's copy is used by article tag pickers. A refresh failure must not turn a confirmed write into a retryable write.
        Promise.resolve(dispatch(fetchTags() as never)).catch(() => message.warning('标签已保存，其他列表暂未刷新'));
    }
    async function save(values: Fields) {
        if (busyRef.current) return;
        if (missing) { setError('此标签已被删除。请另选标签，或明确点击新建。'); return; }
        const title = values.title.trim();
        if (!title) { setError('请输入标签名称'); return; }
        const parent = data.find(node => node.id === values.fatherTag);
        if (mode.kind === 'create' && level === 'two' && !parent) { setError('请选择一个现有的所属主标签'); return; }
        const color = typeof values.color === 'string' ? values.color : values.color?.toHexString();
        const payload = { title, color: color || parent?.color || DEFAULT_COLOR };
        busyRef.current = true;
        setBusy(true);
        setError('');
        try {
            const res = mode.kind === 'edit'
                ? await (mode.node.level === 'one' ? updateTagOne(mode.node.id, payload) : updateTagTwo(mode.node.id, payload))
                : await (level === 'one' ? addTagOne(payload) : addTagTwo({ ...payload, fatherTag: parent!.id }));
            if (!ok(res)) { setError(errMsg(res, '保存失败，请重试')); return; }
            message.success(mode.kind === 'edit' ? '标签已更新' : '标签已创建');
            if (mode.kind === 'create') form.setFieldsValue({ title: '' });
            await refresh();
            syncGlobal();
        } catch {
            setError('保存失败，请检查网络后重试，填写内容已保留');
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    }

    const deleting = allNodes.filter(node => checked.includes(node.key));
    const cascaded = deleting.filter(node => node.level === 'one').flatMap(node => node.children || []);
    async function remove() {
        if (busyRef.current || !deleting.length) return;
        busyRef.current = true;
        setBusy(true);
        setError('');
        let completed = 0;
        try {
            // Children are deleted first. Each request has its own transaction; retain failed selections if the second group fails.
            for (const lv of ['two', 'one'] as const) {
                const group = deleting.filter(node => node.level === lv && !(lv === 'two' && deleting.some(parent => parent.level === 'one' && parent.id === node.parentId)));
                if (!group.length) continue;
                const res = await delTag(lv, group.map(node => node.id));
                if (!ok(res)) throw new Error(errMsg(res, '删除失败'));
                completed += group.length;
                const removed = new Set(group.flatMap(node => [node.key, ...(node.children || []).map(child => child.key)]));
                setChecked(keys => keys.filter(key => !removed.has(String(key))));
            }
            setDeleteOpen(false);
            message.success('所选标签已删除，文章内容保留');
        } catch (reason) {
            setError(`${completed ? '部分标签已删除；剩余选择已保留。' : ''}${reason instanceof Error ? reason.message : '删除失败，请重试'}`);
            setDeleteOpen(false);
        } finally {
            await refresh();
            syncGlobal();
            busyRef.current = false;
            setBusy(false);
        }
    }
    const filtered = useMemo(() => {
        const query = search.trim().toLocaleLowerCase();
        if (!query) return data;
        return data.flatMap(one => {
            if (one.title.toLocaleLowerCase().includes(query)) return [one];
            const children = one.children?.filter(two => two.title.toLocaleLowerCase().includes(query));
            return children?.length ? [{ ...one, children }] : [];
        });
    }, [data, search]);

    return <section className="tag_card" aria-label="标签管理">
        <header className="tag-header"><div><h2><TagsOutlined aria-hidden="true" /> 标签管理</h2><p>主标签整理主题，子标签细分内容。点名称编辑，勾选框只用于批量删除。</p></div>
            <Space wrap><Button icon={<ReloadOutlined aria-hidden="true" />} disabled={busy || loading} onClick={() => void refresh()}>刷新标签</Button><Button type="primary" icon={<PlusOutlined aria-hidden="true" />} disabled={busy} onClick={() => create('one')}>新建主标签</Button></Space>
        </header>
        {error && <Alert type="error" showIcon message={error} />}
        {loadError && <Alert type="error" showIcon message={loadError} />}
        <div className="tag-workspace">
            <div className="tag-library">
                <Input.Search aria-label="搜索标签" placeholder="搜索主标签或子标签" allowClear value={search} onChange={event => setSearch(event.target.value)} />
                <div className="tag-selection"><span>已勾选 {checked.length} 个</span><Button danger disabled={!checked.length || busy} onClick={() => setDeleteOpen(true)}>删除所选标签</Button></div>
                {loading ? <Spin tip="正在加载标签"><div style={{ minHeight: 120 }} /></Spin> : filtered.length ? <Tree
                    checkable checkStrictly blockNode showLine defaultExpandAll
                    key={search ? 'search' : 'all'}
                    selectedKeys={mode.kind === 'edit' ? [mode.node.key] : []}
                    checkedKeys={checked}
                    disabled={busy}
                    onSelect={keys => { if (keys[0]) edit(keys[0]); }}
                    onCheck={keys => setChecked(Array.isArray(keys) ? keys : keys.checked)}
                    treeData={filtered}
                    titleRender={node => <span className="tag-tree-title"><Tag color={node.color}>{node.title}</Tag><small>{node.level === 'one' ? '主标签' : '子标签'}</small></span>}
                /> : loadError ? null : <Empty description={search ? '没有匹配的标签，试试其他关键词' : '还没有标签，从创建主标签开始'} />}
            </div>
            <div className="newTagForm">
                <h3>{mode.kind === 'edit' ? `编辑${level === 'one' ? '主' : '子'}标签「${mode.node.title}」` : `新建${level === 'one' ? '主' : '子'}标签`}</h3>
                {missing && <Alert type="warning" message="此标签已不在列表中，不能保存。请另选标签或点击新建。" />}
                {mode.kind === 'create' && <Space className="tag-create-switch"><Button type={level === 'one' ? 'primary' : 'default'} disabled={busy} onClick={() => create('one')}>主标签</Button><Button type={level === 'two' ? 'primary' : 'default'} disabled={busy || !data.length} onClick={() => create('two')}>子标签</Button></Space>}
                <Form form={form} layout="vertical" initialValues={{ color: DEFAULT_COLOR }} onFinish={save} disabled={busy}>
                    <Form.Item name="title" label="标签名称" rules={[{ required: true, whitespace: true, message: '请输入标签名称' }]}><Input placeholder="例如：编程、旅行、读书" maxLength={100} /></Form.Item>
                    {level === 'two' && <Form.Item name="fatherTag" label="所属主标签" rules={[{ required: mode.kind === 'create', message: '请选择所属主标签' }]} extra={mode.kind === 'edit' ? '这里仅修改名称与颜色，所属主标签保持不变。' : '新标签会放在所选主标签下方。'}>
                        <Select placeholder="选择一个主标签" showSearch optionFilterProp="label" disabled={mode.kind === 'edit' || busy} options={data.map(node => ({ value: node.id, label: node.title }))} onChange={value => form.setFieldValue('color', data.find(node => node.id === value)?.color || DEFAULT_COLOR)} />
                    </Form.Item>}
                    <Form.Item name="color" label="显示颜色"><ColorPicker showText format="hex" /></Form.Item>
                    <Space wrap><Button type="primary" htmlType="submit" loading={busy} disabled={missing}>{mode.kind === 'edit' ? '保存修改' : '创建标签'}</Button>
                        {mode.kind === 'edit' && <Button disabled={busy} onClick={() => create('one')}>结束编辑</Button>}
                    </Space>
                </Form>
                {mode.kind === 'edit' && level === 'one' && <Button className="tag-child-action" icon={<PlusOutlined aria-hidden="true" />} disabled={busy || missing} onClick={() => create('two', mode.node.id)}>在此主标签下新建子标签</Button>}
                {mode.kind === 'create' && level === 'two' && !parentId && <p className="tag-help">先选所属主标签，颜色会默认沿用它的颜色。</p>}
            </div>
        </div>
        <Modal title="确认删除标签" open={deleteOpen} onCancel={() => { if (!busyRef.current) setDeleteOpen(false); }} onOk={() => void remove()} okText="确认删除" cancelText="保留标签" okButtonProps={{ danger: true, loading: busy }} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy}>
            <p>将删除：{deleting.map(node => node.title).join('、')}。</p>
            {cascaded.length > 0 && <Alert type="warning" message={`主标签下的 ${cascaded.length} 个子标签也会删除：${cascaded.map(node => node.title).join('、')}`} />}
            <p>相关文章上的标签关联会移除，文章内容不会删除。此操作不能撤销。</p>
        </Modal>
    </section>;
}
