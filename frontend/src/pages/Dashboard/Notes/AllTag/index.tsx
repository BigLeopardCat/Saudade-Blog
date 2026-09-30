import './inedx.sass'
import {
    Button,
    ColorPicker,
    Form,
    Input,
    Select,
    Tag,
    Tree,
    Alert, message,
} from "antd";
import React, {useEffect, useMemo, useRef, useState} from "react";
import {ReloadOutlined, TagsOutlined} from '@ant-design/icons'
import {TagLevelOne} from "../../../../interface/TagType";
import {fetchTags} from "../../../../store/components/tags.tsx";
import {useDispatch} from "react-redux";
import {addTagOne, addTagTwo, delTag, initTree, updateTagOne, updateTagTwo} from "../../../../apis/TagMethods.tsx";
import {useLiveRefresh} from "../../../../utils/liveRefresh.ts";

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
 *
 * 20261001 第四轮（用户：「标签管理界面操作逻辑优化，选中右侧的标签，左侧参数自动填充，
 * 进而实现快速二次编辑或者删除」）：
 *
 * 4. **左侧表单从"只会新增"变成"选中即填充、就地改"**。改版前选中右侧树里的标签只有两条
 *    路可走：删除（直接吃 selectedKeys）与弹窗编辑（弹窗里是另一套 title/color 输入框，
 *    与左侧表单互不相干）。于是"改个标签"要先选中、再点编辑、再在弹窗里改、再保存 ——
 *    而左侧那张表单明明有同样的四个字段，却只会在提交时新建一个同名标签。
 *    现在选中一个节点就把 title/level/fatherTag/color 灌进左侧表单，主按钮在
 *    「添加 ↔ 保存修改」之间切换，弹窗整块删掉（同一件事不留两个入口）。
 * 5. **层级与父标签在修改态是禁用的**（灰掉、只作展示）。PUT /tagone|:id 与 /tagtwo/:id
 *    契约上只收 title+color；换父级、一级↔二级互转是另一条端点（`POST /api/protected/tag/move`，
 *    见 mod.rs 那段注释），它会重写文章的 note.tags，不该在一次"改个名"里顺手触发。
 *    灰掉比"填了不生效"诚实。
 * 6. **取消选中要清空表单**。不清的话表单里留着上一个标签的名字，而主按钮已经变回「添加」
 *    —— 点一下就是"照抄一个同名标签"，这是填充功能必然会带出来的新坑。
 * 7. **编辑目标 =「唯一被选中的那个」**：`Tree` 是 `multiple` 的（批量删除用），而 rc-tree
 *    在多选下的语义是**加选**（再点一个是 arrAdd，不是改选）⇒ 选中两个以上时左侧不填充、
 *    回到"新增"态，并在表单顶部写明这是批量删除模式。这样"左侧表单里是谁"与"删除会删掉谁"
 *    永远对得上：不会出现"表单里显示 A、点删除却连 B 一起删了"。
 */
/**
 * 原始标签树 → `Tree` 组件用的那棵树：**key 带层级前缀**（见文件头第 1 条）。
 * 提成模块级纯函数是为了让 `refresh` 能在 setState 生效之前，用刚拉回来的数据
 * 把选中项解析出来（否则要等下一轮渲染、还得再写一份等价的映射）。
 */
const toTreeData = (list: any): any[] => (Array.isArray(list) ? list : []).map((one: any) => ({
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
}));

const AllTag = () => {
    const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
    const [selectedNode, setSelectedNode] = useState<any>(null);
    const [level,setLevel] = useState('level_1')
    const [staticDate,setStaticDate] = useState<TagLevelOne[]>([])
    // 展开态**受控**：`defaultExpandAll` 在异步数据下是失效的（它只在树第一次渲染时算一遍，
    // 而那一刻 `treeData` 还是空的 —— 标签树是 `initTree()` 拉回来才有）。改版前打开这一页
    // 只能看见一级标签，二级要点一下小三角才出来，"选中二级标签改一下"因此多一步。
    // 现在首次拉到数据时把一级全部展开；`onExpand` 收下后续的人工开合，不再回写。
    const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
    const seededExpand = useRef(false)
    const [form] = Form.useForm()
    const dispatch = useDispatch()
    // `refresh` 是每次渲染重建的闭包，而它拉完树之后要按"此刻选中的是谁"重新解析节点 ——
    // 用 ref 取最新值，别把 selectedKeys 塞进依赖里（那会让 useLiveRefresh 每次点选都重挂定时器）
    const selectedKeysRef = useRef<React.Key[]>([]);

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
        // 首次拿到数据 → 展开全部一级（见上面 expandedKeys 的注释）。**只做一次**：
        // 每次刷新都展开等于把主人刚收起的那几个又弹开（20 秒轮询一次，很烦人）。
        if (!seededExpand.current) {
            seededExpand.current = true
            setExpandedKeys(toTreeData(tree).map((n: any) => n.key))
        }
        // 刷新后按 key 重新解析选中项：别处（看板娘/另一个标签页）把它改名或删了，
        // 左侧表单与选中态要跟着走，不能对着一棵已经不存在的节点按「保存修改」。
        // ⚠️ 只在**节点没了**的时候清表单与选中态；节点还在就只换一份新数据，
        // 绝不回填 —— 那会把主人正在改的名字冲掉。
        const keys = selectedKeysRef.current;
        if (keys.length !== 1) return;
        const node = findNode(keys[0], toTreeData(tree));
        setSelectedNode(node);
        if (!node) {
            selectedKeysRef.current = [];
            setSelectedKeys([]);
            setLevel('level_1');
            form.resetFields();
        }
    }

    useEffect(() => {
        refresh()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* 跨端同步（20260926）：标签树此前只在挂载时拉一次——看板娘在别处改了标签
       （改名/删除/挪父级），开着这一页的主人要手动刷新才看得见。
       现在接 `utils/liveRefresh.ts`（看板娘收尾事件 / 切回可见 / 20 秒轮询）。
       编辑弹窗那个 `skip` 随弹窗一起删了：表单是受控的，后台重拉只换树数据、
       不回填表单（见 refresh 末尾），没有"我看着的那一行被换掉"这回事。 */
    useLiveRefresh(refresh);

    // 节点 key 带层级前缀（见文件头第 1 条）。Tree 上挂的是这棵，`staticDate` 保留原始数据。
    const treeData: any[] = useMemo(() => toTreeData(staticDate), [staticDate]);

    const parseKey = (key: React.Key): {level: 'one' | 'two'; id: number} | null => {
        const matched = /^(one|two)-(\d+)$/.exec(String(key));
        if (!matched) return null;
        return {level: matched[1] as 'one' | 'two', id: Number(matched[2])};
    };

    /** 按 key 找节点。`data` 可显式传入 —— `refresh` 里要用**刚拉回来那棵树**解析，
     *  而那一刻 `treeData` 还是上一轮的（setState 尚未生效）。 */
    const findNode = (key: React.Key, data: any[] = treeData): any => {
        const parsed = parseKey(key);
        if (!parsed) return null;
        if (parsed.level === 'one') {
            return data.find(node => node.level === 'one' && node.id === parsed.id) ?? null;
        }
        for (const one of data) {
            const child = (one.children || []).find((c: any) => c.id === parsed.id);
            if (child) return child;
        }
        return null;
    };

    /** 二级标签的父节点 id（填充「父标签」那一栏用）。 */
    const parentIdOf = (childId: number): number | undefined => {
        for (const one of treeData) {
            if ((one.children || []).some((c: any) => c.id === childId)) return one.id;
        }
        return undefined;
    };

    const onSelect = (selectedKeysValue: React.Key[]) => {
        selectedKeysRef.current = selectedKeysValue;
        setSelectedKeys(selectedKeysValue);
        const node = selectedKeysValue.length === 1 ? findNode(selectedKeysValue[0]) : null;
        setSelectedNode(node);
        if (node) {
            // 选中即填充 —— 「快速二次编辑」的入口就是这一下
            const editLevel = node.level === 'one' ? 'level_1' : 'level_2';
            setLevel(editLevel);
            form.setFieldsValue({
                title: node.title,
                level: editLevel,
                fatherTag: node.level === 'two' ? parentIdOf(node.id) : undefined,
                color: node.color || undefined,
            });
        } else {
            // 取消选中 / 选了多个 ⇒ 回"新增"态，并且**必须清空表单**（见文件头第 6 条）。
            // ⚠️ 只清表单与编辑目标，**不动 selectedKeys** —— 多选正是"批量删除"的选中集，
            // 顺手把它清掉的话，选中三个标签之后点删除会一条都发不出去
            // （本套件第 ⑦ 组逮到的就是这个：`setSelectedKeys` 刚写进去，下一行又被抹成 []）。
            setSelectedNode(null);
            setLevel('level_1');
            form.resetFields();
        }
    };

    const clearSelection = () => {
        selectedKeysRef.current = [];
        setSelectedKeys([]);
        setSelectedNode(null);
        setLevel('level_1');
        form.resetFields();
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
            clearSelection()
            await refresh()
            message.success('删除成功')
        } catch (error) {
            message.error('删除失败')
        }
    };

    const onfinish = async (values: any) => {
        const color = values.color?.toHexString ? values.color.toHexString() : undefined;

        // ── 修改态：选中的那个标签就地改 ──────────────────────────────────────
        // 层级取自**选中节点**（表单里那个「标签等级」在这条路径上是禁用的，见文件头第 5 条），
        // 只提交 title/color —— 与 PUT 端点的契约一致。
        if (selectedNode) {
            const data = {
                title: values.title,
                color: color || selectedNode.color || 'black',
            };
            try {
                const res = selectedNode.level === 'one'
                    ? await updateTagOne(selectedNode.id, data)
                    : await updateTagTwo(selectedNode.id, data);
                if (res?.status === 200) {
                    await refresh()
                    message.success('更新成功')
                } else {
                    message.error('更新失败')
                }
            } catch (error) {
                message.error("更新失败：标签名可能已存在")
            }
            return
        }

        // ── 新增态 ───────────────────────────────────────────────────────────
        if (values.level === 'level_1') {
            const newTag = {
                title: values.title,
                color: color || 'black',
            };
            try {
                const res = await addTagOne(newTag)
                if(res.status === 200){
                    clearSelection()
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
                    clearSelection()
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
                    initialValues={{ tagType: '一级标签', level: 'level_1' }}
                    style={{ maxWidth: '400px' }}
                    name="标签管理"
                    onFinish={onfinish}
                >
                    <h2 style={{ marginBottom: '20px' }}><TagsOutlined /> 标签管理</h2>
                    {/* 选中右侧标签后这里就是那份标签的编辑表单。写清楚"现在改的是谁"，
                        免得主人以为主按钮还是「添加」而建出一个同名标签。
                        ⚠️ 多选那一条不是啰嗦：Tree 是 `multiple` 的，**再点一个标签是"加选"
                        而不是"改选"**（rc-tree 的 arrAdd 语义），所以点第二个之后左边会空掉 ——
                        不说清楚的话那就是个"怎么突然不填了"的谜。 */}
                    <Alert
                        type={selectedNode ? 'info' : (selectedKeys.length > 1 ? 'warning' : 'info')}
                        showIcon
                        style={{ marginBottom: '16px' }}
                        message={selectedNode
                            ? `正在修改「${selectedNode.title}」（${selectedNode.level === 'one' ? '一级' : '二级'}标签）`
                            : (selectedKeys.length > 1
                                ? `已选中 ${selectedKeys.length} 个标签：这是批量删除模式，左侧不填充。要修改请只选中一个`
                                : '在右侧点一个标签：左侧参数会自动填充，改完点「保存修改」')}
                    />
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
                        // 修改态下层级不可改：换层级/换父级走 `POST /api/protected/tag/move`，
                        // 不在这一屏（见文件头第 5 条）
                        extra={selectedNode ? '已有标签的层级不可更改（要换层级请新建一个）' : undefined}
                    >
                        <Select options={[
                            { value: 'level_1', label: '一级标签' },
                            { value: 'level_2', label: '二级标签' },
                        ]} onChange={handleTagTypeChange} disabled={!!selectedNode}/>
                    </Form.Item>

                    {level==='level_2'&& <Form.Item
                        name="fatherTag"
                        label="父标签"
                        shouldUpdate
                        extra={selectedNode ? '已有标签的父级不可更改' : undefined}
                    >
                        <Select options={staticDate.map(tag => ({
                            value: Number(tag.key),
                            label: tag.title
                        }))} disabled={!!selectedNode} />
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
                        <Button type="primary" htmlType="submit">
                            {selectedNode ? '保存修改' : '添加'}
                        </Button>
                        <Button style={{marginLeft: 12}} disabled={selectedKeys.length === 0}
                                onClick={clearSelection}>
                            取消选中
                        </Button>
                        {/* 手动重拉（20260926 与跨端同步一起加的）：自动重拉可能被"弹窗开着"
                            挡下，也可能就在那 20 秒窗口里没到——主人想现在看一眼就给这一下。 */}
                        <Button style={{marginLeft: 12}} icon={<ReloadOutlined />}
                                onClick={() => refresh()}>
                            刷新
                        </Button>
                        <Button type="primary" danger style={{marginLeft: 12}} onClick={Delete}>删除</Button>
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
                    onSelect={onSelect}
                    expandedKeys={expandedKeys}
                    onExpand={(keys) => setExpandedKeys(keys)}
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
    </>
}

export default AllTag
