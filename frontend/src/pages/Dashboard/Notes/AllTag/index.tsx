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
import React, {useEffect, useRef, useState} from "react";
import {TagsOutlined} from '@ant-design/icons'
import {TagLevelOne} from "../../../../interface/TagType";
import {fetchTags} from "../../../../store/components/tags.tsx";
import {useDispatch} from "react-redux";
import {addTagOne, addTagTwo, delTag, initTree, updateTagOne, updateTagTwo} from "../../../../apis/TagMethods.tsx";

const AllTag = () => {
    const tree = useRef(null)
    const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
    const [selectedNode, setSelectedNode] = useState<any>(null);
    const [level,setLevel] = useState('level_1')
    const [staticDate,setStaticDate] = useState<TagLevelOne[]>([])
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [editNode, setEditNode] = useState<any>(null);
    const dispatch = useDispatch()

    useEffect(() => {
        initTree().then((res) => {
            setStaticDate(res)
        })
    }, []);

    // 查找选中节点
    const findNodeByKey = (key: React.Key, nodes: TagLevelOne[]): any => {
        for (const node of nodes) {
            if (node.key === key) return node;
            if (node.children) {
                const found = node.children.find(c => c.key === key);
                if (found) return found;
            }
        }
        return null;
    };

    const onSelect = (selectedKeysValue: React.Key[]) => {
        setSelectedKeys(selectedKeysValue);
        if (selectedKeysValue.length === 1) {
            setSelectedNode(findNodeByKey(selectedKeysValue[0], staticDate));
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
        const res = await delTag(selectedKeys)
        if(res.status === 200){
            const Tree = await initTree()
            setStaticDate(Tree)
            setSelectedKeys([])
            setSelectedNode(null)
            if(tree.current) {
                // @ts-ignore
                tree.current.state.selectedKeys = []
            }
            dispatch<any>(fetchTags())
            message.success("删除成功")
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
            const isLevel1 = !editNode.fatherTag
            const data = {
                title: editNode.title,
                color: editNode.color
            }
            if (isLevel1) {
                await updateTagOne(editNode.key, data)
            } else {
                await updateTagTwo(editNode.key, data)
            }
            const Tree = await initTree()
            setStaticDate(Tree)
            dispatch<any>(fetchTags())
            setEditModalOpen(false)
            setEditNode(null)
            message.success('更新成功')
        } catch (error) {
            message.error('更新失败')
        }
    };

    const onfinish = async (values: any) => {
        if (values.level === 'level_1') {
            let color: string
            if (values.color && values.color.toHexString) {
                color = values.color.toHexString();
            } else {
                color = 'black';
            }
            const newTag = {
                title: values.title,
                color: color,
            };
            try {
                const res = await addTagOne(newTag)
                if(res.status === 200){
                    const Tree = await initTree()
                    setStaticDate(Tree)
                    dispatch<any>(fetchTags())
                    message.success('添加成功');
                }
            } catch (error) {
                await message.error("添加失败：" + '已存在')
            }
        } else {
            const fatherTag = staticDate.find(item => item.key === values.fatherTag);
            if (fatherTag) {
                const len = fatherTag.children?.length
                const newTag = {
                    title: values.title,
                    tagKey: fatherTag?.children.length > 0 ? fatherTag.children[len - 1].key + 1 : fatherTag.key * 100 + 1,
                    color: fatherTag.color,
                    fatherTag: fatherTag.key,
                }
                try {
                    const res = await addTagTwo(newTag)
                    if(res.status === 200){
                        const Tree = await initTree()
                        setStaticDate(Tree)
                        dispatch<any>(fetchTags())
                        message.success('添加成功');
                    }
                } catch (error) {
                    await message.error("添加失败：" + '已存在')
                }
            }
        }
    }

    return <>
        <div className="tag_card">
            <div className='newTagForm'>
                <Form
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
                            value: tag.key,
                            label: tag.title
                        }))} />
                    </Form.Item>}

                    {level==='level_1'&& <Form.Item
                        name="color"
                        label="标签颜色"
                    >
                        <ColorPicker defaultValue="black" showText format={"hex"}/>
                    </Form.Item>}

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
                    treeData={staticDate}
                    titleRender={(node) => (
                        <Tag color={node.color}>{node.title}</Tag>
                    )}
                    ref={tree}
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
                </div>
            )}
        </Modal>
    </>
}

export default AllTag
