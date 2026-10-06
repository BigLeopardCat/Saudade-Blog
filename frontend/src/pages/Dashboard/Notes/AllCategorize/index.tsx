import './index.sass'
import {
    ColorPicker,
    Form,
    Grid,
    Input, message,
    Modal, Popconfirm,
    Space,
    Table,
    TableProps,
    Tag,
} from "antd";
import React, {useEffect, useState} from "react";
import {FolderOpenOutlined, QuestionCircleOutlined, ReloadOutlined} from '@ant-design/icons';
import {CategoriesType} from "../../../../interface/CategoriesType";
import {fetchCategories} from "../../../../store/components/categories.tsx";
import {useDispatch} from "react-redux";
import {Fab} from "@mui/material";
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import {
    addCategory,
    delAllCategory,
    delCategory,
    getCategories,
    updateCategory
} from "../../../../apis/CategoryMethods.tsx";
import {useLiveRefresh} from "../../../../utils/liveRefresh.ts";
const  AllCategorize = () => {    //hooks区域
    /* 窄屏（< `screenLG`，本仓在 `WASHI_THEME.common` 里抬到 1024）不再横向拖表。
       用 antd 自己的 `useBreakpoint` 而不是另写一条 `matchMedia('(max-width:1024px)')`：
       它读的正是同一颗 `screenLG` 令牌 ⇒ **断点只有一处事实源**，不会跟 CSS 那边漂开。
       （它内部是 `useLayoutEffect`，首帧那个空的 `{}` 来不及上屏就被 forceUpdate 顶掉，
       所以桌面不会闪一下"窄屏形态"。） */
    const screens = Grid.useBreakpoint();
    const isNarrow = !screens.lg;
    const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
    const [staticDate,setStaticDate] = useState<CategoriesType[]>([])
    const [open, setOpen] = useState(false);
    const [confirmLoading, setConfirmLoading] = useState(false);
    const [isEdit,setEdit] = useState(0)
    const [form] = Form.useForm();
    const dispatch = useDispatch()
    const [isModalOpen, setIsModalOpen] = useState(false);

    useEffect(() => {
       initCategoryList()
    },[])

    /* 跨端同步（20260926）：分类列表此前只在挂载时拉一次（增删改之后各自重拉一次本地的），
       看板娘在别处改了分类这一页就停在旧的。现在接 `utils/liveRefresh.ts`
       （看板娘收尾事件 / 切回可见 / 20 秒轮询）。
       `skip`：新增/编辑/删除确认弹出着就不重拉——那几个弹窗认的是一份快照
       （`isEdit`/被选中的行），底下的表在它开着的时候换掉，按确定时落的就不是主人看到的那一行。 */
    useLiveRefresh(initCategoryList, { skip: () => isModalOpen || open });

    async function initCategoryList(){
        const res = await getCategories()
        if(res.status===200){
            setStaticDate(res.data.data.map((item: { categoryKey: number; categoryTitle: string; color: string; icon: string; introduce: string; noteCount: number; pathName:string}) => {
                // // const matchedNotes = noteList.filter((note: { noteCategory: string; }) => note.noteCategory === item.categoryTitle);
                return {
                    key: item.categoryKey,
                    categoryTitle: item.categoryTitle,
                    pathName: item.pathName,
                    color: item.color,
                    icon: item.icon,
                    introduce: item.introduce,
                    noteCount: item.noteCount
                }
            }))
        }
    }

    //回调函数区域
    //删除逻辑
    const Delete = async (key:number) => {
        const res = await delCategory(key)
        if(res.status === 200){
            await initCategoryList()
            dispatch<any>(fetchCategories())
            message.success('删除成功')
        }
    }

    const DeleteAll = async () => {
        if (selectedRowKeys.length === 0) {
            message.warning('待选中')
        } else {
            const res = await delAllCategory(selectedRowKeys)
            try {
                if (res.status === 200) {
                    await initCategoryList()
                    dispatch<any>(fetchCategories())
                    message.success('删除成功')
                }
            } catch (error) {
                console.log(error)
            }
            setSelectedRowKeys([])
        }
    }

    //编辑逻辑
    const Change_Categories = (value:CategoriesType) => {
        setEdit(value.key)
        showModal()
        form.setFieldsValue({
            categorie: value.categoryTitle,
            introduce: value.introduce,
            categorie_icon: value.icon,
            categorie_color: value.color,
            pathName: value.pathName
        });
    }

    //表单提交
    const onfinish = async () => {
        // 获取整个表单的值
        const {categorie,introduce,categorie_icon,categorie_color} = form.getFieldsValue();
        const colorValue = typeof categorie_color === "string" ? categorie_color : (categorie_color?.toHexString ? categorie_color.toHexString() : "#000000");
        const data:{ color: string; introduce: string;categoryTitle: string; icon: string,pathName:string } = {
            categoryTitle: categorie,
            icon:categorie_icon,
            color: colorValue,
            introduce:introduce,
            pathName: form.getFieldsValue().pathName
        }
        try {
            const res = await addCategory(data)
            if(res.status === 200){
                await initCategoryList()
                dispatch<any>(fetchCategories())
                message.success('添加成功')
            }
        }catch (error){
            console.log(error)
        }
    }

    const handleOk = async () => {
        if (isEdit !== 0) {
            const update = {
                categoryTitle: form.getFieldsValue().categorie,
                introduce: form.getFieldsValue().introduce,
                icon: form.getFieldsValue().categorie_icon,
                color: form.getFieldsValue().categorie_color.toHexString(),
                pathName: form.getFieldsValue().pathName
            }
            try {
                const res = await updateCategory(update, isEdit)
                if (res.status === 200) {
                    await initCategoryList()
                    message.success('更新成功')
                }
            } catch (error) {
                console.log(error)
            }
            setEdit(0);
            form.resetFields();
            setOpen(false);
        } else {
            form.validateFields().then(() => {
                setConfirmLoading(true);
                onfinish();
                setConfirmLoading(false);
                form.resetFields();
                setOpen(false);
            });
        }
    };

    const handleCancel = () => {
        form.resetFields()
        setEdit(0)
        setOpen(false);
    };

    //表单选中
    const onSelectChange = (newSelectedRowKeys: React.Key[]) => {
        setSelectedRowKeys(newSelectedRowKeys);
    };
    const rowSelection = {
        selectedRowKeys,
        onChange: onSelectChange,
    };
    const hasSelected = selectedRowKeys.length > 0;
    //添加框打开
    const showModal = () => {
        setOpen(true);
    };

    //Tab数据
    // ⚠️ **窄屏裁列（20261006 用户第 6 条）**：三列挂 `responsive: ['lg']`（视口 <
    // `screenLG`，本仓在 `WASHI_THEME.common` 里抬到 1024），窄屏只留 序列 / 分类名称 /
    // 文章数量 / 操作。本页的横向溢出原本由下面 `scroll` 的 `x:1000` 兜着 ——
    // 那是"整张表 1000px 宽、装不下的横向拖"，手机上等于一进去就得拖着看；
    // 窄屏去掉 `x`（保留 `y`）＋ 裁掉三列，剩下的自然落进屏宽。宽屏逐像素不变。
    const columns: TableProps<CategoriesType>['columns'] = [
        {
          title: '序列',
            render: (_text, _record, index) => index + 1,
          key: 'key',
          align: "center",
        },
        {
            title: '分类名称',
            dataIndex: 'categoryTitle',
            key: 'key',
            align: "center",
        },
        {
            title: '分类介绍',
            dataIndex: 'introduce',
            key: 'key',
            align: "center",
            responsive: ['lg'],
        },
        {
            title: '分类图标',
            dataIndex: 'icon',
            key: 'key',
            align: "center",
            responsive: ['lg'],
            render: (icon) => <i className={`fa ${icon}`} aria-hidden="true"></i>
        },
        {
            title: '文章数量',
            key: 'key',
            dataIndex: 'noteCount',
            align: "center",
        },
        {
            title: '颜色',
            key: 'key',
            dataIndex: 'color',
            align: "center",
            responsive: ['lg'],
            render: (color) => <Tag color={color}>{color}</Tag>
        },
        {
            title: '操作',
            key: 'key',
            align: "center",
            // 只有这一列在窄屏给宽度（其余留着不写 = 让浏览器均分）：`操作` 里是两颗 40px 的
            // 圆钮（`Space` 中间还隔 8px ⇒ 至少要 88px），均分下来的那一份装不下。
            // 实测 390 视口：均分是 81px（容器再窄到真实卡片里只剩 ~68px）。
            // 宽屏给 `undefined` = 与改动前逐像素一致。
            width: isNarrow ? '28%' : undefined,
            render: (item) => (
                <Space size="middle">
                    <Fab color="info" aria-label="edit" size='small' onClick={() => Change_Categories(item)}>
                        <EditIcon />
                    </Fab>
                    <Popconfirm
                        title="删除确认"
                        description="确定删除此分类？"
                        icon={<QuestionCircleOutlined style={{ color: 'red' }} />}
                        okText='删除'
                        onConfirm={() => Delete(item.key)}
                        cancelText='取消'
                    >
                        <Fab color="error" aria-label="delete" size='small'>
                            <DeleteIcon />
                        </Fab>
                    </Popconfirm>

                </Space>
            ),
        },
    ];

    //列表样式
    const listStyle: React.CSSProperties = {
        lineHeight: '200px',
        textAlign: 'center',
        // background 挪到 index.sass 的 `.catListBox`（20260923）：内联样式特异性最高，
        // 写死 'white' 就意味着夜间永远是块白砖 —— 只有落到类选择器上才加得出 `.dark` 变体。
        borderRadius: '10px',
        marginTop: 10,
        maxWidth: '98%',
        height: '90%',
        marginLeft: '1%',
        overflowY: 'hidden'
    };
    const formItemLayout = {
        labelCol: {
            xs: { span: 24 },
            sm: { span: 6 },
        },
        wrapperCol: {
            xs: { span: 24 },
            sm: { span: 14 },
        },
    };

    const showdelModal = () => {
        setIsModalOpen(true);
    };

    const handledelOk = () => {
        DeleteAll()
        setIsModalOpen(false);
    };

    const handledelCancel = () => {
        setIsModalOpen(false);
    };
    /* 窄屏去掉 `x`（那是"整张表写死 1000px 宽"的横向拖，手机上毫无意义；裁掉三列之后
       剩下的本来就装得下）。`y`（480 竖向滚动）两档都留着。 */
    const tableScroll = isNarrow ? { y: 480 } : { y: 480, x: 1000 };
    return <>
        <div style={listStyle} className="searchRes catListBox">
            <Table columns={columns} dataSource={staticDate} pagination={{pageSize: 8}}
                   title={() => <>
                           <div style={{float: 'left',display:'flex'}} >
                               <Fab color="primary" aria-label="add" size='small' onClick={showModal}>
                                   <AddIcon />
                               </Fab>
                               {/* 手动重拉（20260926 与跨端同步一起加的） */}
                               <Fab color="default" aria-label="reload" size='small'
                                    style={{marginLeft: 10}} onClick={() => initCategoryList()}>
                                   <ReloadOutlined />
                               </Fab>
                               <div style={{position:'absolute',width:220}}>
                                   {hasSelected&&<Fab variant="extended" color='error' size='medium' style={{ marginLeft: 10}} onClick={showdelModal}>
                                       <DeleteForeverIcon sx={{ mr: 1 }} className='allin'/>
                                       批量删除
                                   </Fab>}
                               </div>
                           </div>
                       <h2 style={{marginRight: 150}}>
                           <FolderOpenOutlined /> 分类管理
                       </h2>
                   </>}
                   rowSelection={rowSelection}
                   scroll={tableScroll}
            />
        </div>

        <Modal
            title="分类新增"
            open={open}
            onOk={handleOk}
            confirmLoading={confirmLoading}
            onCancel={handleCancel}
            okText={isEdit=== 0? '添加' : '保存'}
            cancelText='取消'
            getContainer={false}
        >
            <Form {...formItemLayout} variant="filled" style={{ maxWidth: 600 }} form={form} onFinish={onfinish}>
                <Form.Item label="分类名称" name="categorie" >
                    <Input/>
                </Form.Item>

                <Form.Item label="路径名称" name="pathName" >
                    <Input/>
                </Form.Item>

                <Form.Item
                    label="分类介绍"
                    name="introduce"
                    rules={[{ required: true, message: 'Please input!' }]}
                >
                    <Input.TextArea autoSize={{ minRows: 4, maxRows: 8 }}/>
                </Form.Item>


                <Form.Item label="分类图标" name="categorie_icon"
                           rules={[{ required: true, message: 'Please input!' }]}
                >
                    <Input/>
                </Form.Item>

                <Form.Item label="颜色" name="categorie_color" >
                    <ColorPicker defaultValue="black" showText  disabledAlpha/>
                </Form.Item>
            </Form>
        </Modal>

        <Modal title="删除确认" open={isModalOpen} onOk={handledelOk} onCancel={handledelCancel} okText="确定" cancelText="取消" getContainer={false}>
            是否删除选中所有分类?
        </Modal>
    </>
}
export default  AllCategorize
