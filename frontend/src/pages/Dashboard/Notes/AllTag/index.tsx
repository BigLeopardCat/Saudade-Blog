import './inedx.sass'
import {
    Button,
    ColorPicker,
    Form,
    Input,
    Modal,
    Select,
    Tag,
    Tree,
    Alert, message,
} from "antd";
import React, {useEffect, useMemo, useState} from "react";
import {TagsOutlined} from '@ant-design/icons'
import {TagLevelOne} from "../../../../interface/TagType";
import {fetchTags} from "../../../../store/components/tags.tsx";
import {useDispatch} from "react-redux";
import {addTagOne, addTagTwo, delTag, initTree, updateTagOne, updateTagTwo} from "../../../../apis/TagMethods.tsx";

/**
 * 标签管理页。
 *
 * 20260919 修的三件事（都改了数据，不只是显示）：
 *
 * 1. **树节点 key 加层级前缀**。以前两级标签直接用各自的数字 id 当 key，而两张表的
 *    自增序列是独立的、历史上还会重号 —— 一级 #13 与二级 #13 在树里是同一个 key，
 *    选中/编辑/删除都可能落到另一个层级的标签上。现在 key 是 `one-13` / `two-13`，
 *    层级由 key 本身携带，不再靠猜。
 * 2. **编辑时按 key 里的层级选表**。原来判断"是不是一级标签"用的是 `!editNode.fatherTag`
 *    —— 一个孤儿二级标签（父标签被删/改名导致 fatherTag 为空）会被当成一级标签，
 *    然后拿它的 id 去更新 `tag_one`，**改错表、还可能改到同号的另一级标签**。
 * 3. **删除带上层级**。旧接口收一个 id 数组然后同时去两张表删（见 `delTag` 注释），
 *    删一级 #13 会连带删掉八竿子打不着的二级 #13。
 */
const AllTag = () => {
    const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
    const [selectedNode, setSelectedNode] = useState<any>(null);
    const [level,setLevel] = useState('level_1')
    const [staticDate,setStaticDate] = useState<TagLevelOne[]>([])
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [editNode, setEditNode] = useState<any>(null);
    const [form] = Form.useForm()
    const dispatch = useDispatch()

    // 二级标签的颜色：默认跟着父标签走（以前二级标签压根没有颜色选择器，
    // 只能默默继承父色，想改也改不了）
    const fatherId = Form.useWatch('fatherTag', form);
    const fatherColor = useMemo(() => {
        const father = staticDate.find(item => Number(item.key) === Number(fatherId));
        return father?.color || 'black';
    }, [fatherId, staticDate]);

    const refresh = async () => {
        const tree = await initTree()
        setStaticDate(tree)
        dispatch<any>(fetchTags())
    }

    useEffect(() => {
        refresh()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 节点 key 带层级前缀（见文件头第 1 条）。Tree 上挂的是这棵，`staticDate` 保留原始数据。
    const treeData: any[] = useMemo(() => staticDate.map((one: any) => ({
        key: `one-${one.key}`,
        title: one.title,
        color: one.color,
        level: 'one' as const,
        id: Number(one.key),
        children: (Array.isArray(one.children) ? one.children : []).map((two: any) => ({
            key: `two-${two.key}`,
            title: two.title,
            color: two.color,
            level: 'two' as const,
            id: Number(two.key),
        })),
    })), [staticDate]);

    const parseKey = (key: React.Key): {level: 'one' | 'two'; id: number} | null => {
        const matched = /^(one|two)-(\d+)$/.exec(String(key));
        if (!matched) return null;
        return {level: matched[1] as 'one' | 'two', id: Number(matched[2])};
    };

    const findNode = (key: React.Key): any => {
        const parsed = parseKey(key);
        if (!parsed) return null;
        const parent = treeData.find(node => node.level === 'one' && node.id === parsed.id);
        if (parsed.level === 'one') return parent ?? null;
        for (const one of treeData) {
            const child = (one.children || []).find((c: any) => c.id === parsed.id);
            if (child) return child;
        }
        return null;
    };

    const onSelect = (selectedKeysValue: React.Key[]) => {
        setSelectedKeys(selectedKeysValue);
        if (selectedKeysValue.length === 1) {
            setSelectedNode(findNode(selectedKeysValue[0]));
        } else {
            setSelectedNode(null);
        }
    };

    const handleTagTypeChange = (value:string) => {
        setLevel(value);
    };

    const Delete = async () => {
        if (selectedKeys.length === 0) {
            message.warning('待选中')
            return
        }
        // 按层级分组：一次请求只删一张表（后端接口要求带 level）
        const groups: {one: number[]; two: number[]} = {one: [], two: []};
        selectedKeys.forEach(key => {
            const parsed = parseKey(key);
            if (parsed) groups[parsed.level].push(parsed.id);
        });
        try {
            for (const lv of ['one', 'two'] as const) {
                if (groups[lv].length === 0) continue;
                const res = await delTag(lv, groups[lv]);
                if (res?.status !== 200) {
                    message.error('删除失败')
                    return
                }
            }
            // 后端删完标签后会顺手把 note.tags 里指向它们的 id 摘掉（prune_note_tags），
            // 文章列表上不会再留下指向已删标签的空白小块。
            await refresh()
            setSelectedKeys([])
            setSelectedNode(null)
            message.success('删除成功')
        } catch (error) {
            message.error('删除失败')
        }
    };

    // 打开编辑弹窗
    const openEdit = () => {
        if (!selectedNode) {
            message.warning('请先选中一个标签')
            return
        }
        setEditNode({...selectedNode})
        setEditModalOpen(true)
    };

    // 提交编辑
    const handleEditOk = async () => {
        if (!editNode) return
        try {
            const data = {
                title: editNode.title,
                color: editNode.color
            }
            // 层级取自节点 key（不再用 `!editNode.fatherTag` 猜——见文件头第 2 条）
            if (editNode.level === 'one') {
                await updateTagOne(editNode.id, data)
            } else {
                await updateTagTwo(editNode.id, data)
            }
            await refresh()
            setEditModalOpen(false)
            setEditNode(null)
            message.success('更新成功')
        } catch (error) {
            message.error('更新失败')
        }
    };

    const onfinish = async (values: any) => {
        const color = values.color?.toHexString ? values.color.toHexString() : undefined;
        if (values.level === 'level_1') {
            const newTag = {
                title: values.title,
                color: color || 'black',
            };
            try {
                const res = await addTagOne(newTag)
                if(res.status === 200){
                    await refresh()
                    message.success('添加成功');
                }
            } catch (error) {
                message.error("添加失败：标签名可能已存在")
            }
        } else {
            const father = staticDate.find(item => Number(item.key) === Number(values.fatherTag));
            if (!father) {
                message.warning('请选择父标签')
                return
            }
            // 注意这里**不再伪造 tagKey**（旧版按 `父key*100+1` 编了个假 id 传给后端，
            // 后端根本不看这个字段，id 一律由数据库自增分配）。
            // `fatherTag` 字段传的是父标签 **id**（后端 UpsertTagTwo 就是这么读的）。
            const newTag = {
                title: values.title,
                color: color || father.color || 'black',
                fatherTag: Number(father.key),
            }
            try {
                const res = await addTagTwo(newTag)
                if(res.status === 200){
                    await refresh()
                    message.success('添加成功');
                }
            } catch (error) {
                message.error("添加失败：标签名可能已存在")
            }
        }
    }

    return <>
        <div className="tag_card">
            <div className='newTagForm'>
                <Form
                    form={form}
                    initialValues={{ tagType: '一级标签' }}
                    style={{ maxWidth: '400px' }}
                    name="标签管理"
                    onFinish={onfinish}
                >
                    <h2 style={{ marginBottom: '20px' }}><TagsOutlined /> 标签管理</h2>
                    <Form.Item
                        name="title"
                        label="标签名称"
                        rules={[{ required: true ,message: '必填项' }]}
                    >
                        <Input />
                    </Form.Item>

                    <Form.Item
                        name="level"
                        label="标签等级"
                    >
                        <Select options={[
                            { value: 'level_1', label: '一级标签' },
                            { value: 'level_2', label: '二级标签' },
                        ]} onChange={handleTagTypeChange}/>
                    </Form.Item>

                    {level==='level_2'&& <Form.Item
                        name="fatherTag"
                        label="父标签"
                        shouldUpdate
                    >
                        <Select options={staticDate.map(({ children, ...rest }) => rest).map(tag => ({
                            value: Number(tag.key),
                            label: tag.title
                        }))} />
                    </Form.Item>}

                    {/* 两级都给颜色选择器：二级的默认值是父标签的颜色，也可以自己改 */}
                    <Form.Item
                        name="color"
                        label="标签颜色"
                        key={level === 'level_2' ? `color-${fatherColor}` : 'color-one'}
                    >
                        <ColorPicker defaultValue={level === 'level_2' ? fatherColor : 'black'} showText format={"hex"}/>
                    </Form.Item>

                    <Form.Item>
                        <Button type="primary" htmlType="submit">添加</Button>
                        <Button type="primary" style={{marginLeft: 20}} onClick={openEdit}>编辑</Button>
                        <Button type="primary" style={{marginLeft: 20, backgroundColor: '#f5222d'}} onClick={Delete}>删除</Button>
                    </Form.Item>
                    <Alert
                        message={`选中标签：${selectedKeys.length} 个`}
                        type="warning"
                        showIcon
                        style={{
                            position: 'absolute',
                            bottom: 10,
                            left: '50%',
                            transform: 'translateX(-50%)',
                            width: '90%',
                            transition: '0.3s',
                            opacity: selectedKeys.length===0?0:1
                        }}
                    />
                </Form>
            </div>
            <div style={{display:'flex',alignItems:'flex-start',justifyContent:'center',height:'100%'}}>
                <Tree
                    showLine
                    multiple
                    defaultExpandAll
                    onSelect={onSelect}
                    // 受控：以前靠 `tree.current.state.selectedKeys = []` 直接改组件内部状态，
                    // React 不知情、也不保证下次渲染还在
                    selectedKeys={selectedKeys}
                    treeData={treeData}
                    titleRender={(node: any) => (
                        <Tag color={node.color}>{node.title}</Tag>
                    )}
                    virtual={true}
                    height={500}
                />
            </div>
        </div>

        {/* 编辑标签弹窗 */}
        <Modal
            title="编辑标签"
            open={editModalOpen}
            onOk={handleEditOk}
            onCancel={() => { setEditModalOpen(false); setEditNode(null); }}
            okText="保存"
            cancelText="取消"
        >
            {editNode && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div>
                        <label style={{ display: 'block', marginBottom: 4 }}>标签名称</label>
                        <Input
                            value={editNode.title}
                            onChange={(e) => setEditNode({...editNode, title: e.target.value})}
                        />
                    </div>
                    <div>
                        <label style={{ display: 'block', marginBottom: 4 }}>标签颜色</label>
                        <ColorPicker
                            value={editNode.color}
                            onChange={(c) => setEditNode({...editNode, color: c.toHexString()})}
                            showText
                            format="hex"
                        />
                    </div>
                    <div style={{opacity: .6, fontSize: 12}}>
                        {editNode.level === 'one' ? '一级标签' : '二级标签'}
                    </div>
                </div>
            )}
        </Modal>
    </>
}

export default AllTag
