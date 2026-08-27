import Editor_ from "../../../../components/Editor";
import './index.sass'
import {
    Button,
    Input,
    Form,
    Modal,
    Select,
    Upload, Switch, Radio, TreeSelect, ConfigProvider, UploadProps, UploadFile, GetProp, message, Row, Col, Card
} from "antd";
import {PlusOutlined, PictureOutlined} from "@ant-design/icons";
import React, {useEffect,  useState, useContext, useRef} from "react";
import MainContext from "../../../../components/conText.tsx";
import dayjs from "dayjs";
import {useDispatch, useSelector} from "react-redux";
import {useNavigate, useParams} from "react-router-dom";
import {fetchNoteList} from "../../../../store/components/note.tsx";
import generateResponse from "../../../../apis/chatgpt.tsx";
import {createNote, getNoteById, updateNote} from "../../../../apis/NoteMethods.tsx";
import ImageCompression from "../../../../apis/ImageCompression.tsx";
import {uploadImages, getImageList} from "../../../../apis/ImageMethods.tsx";
import { resolveApiAssetUrl } from '../../../../utils/runtimeApi';

type FileType = Parameters<GetProp<UploadProps, 'beforeUpload'>>[0];


const NewNotes = () => {
    //hooks区域
    //文章提交表单
    const [open, setOpen] = useState(false);
    const [noteTitle,setTitle] = useState('')
    const [noteContent, setNoteContent] = useState('')
    const [coverImg,setCoverImg] = useState('')
    const [aiContent,setAiContent] = useState('')
    const [noteTag, setNoteTag] = useState<number[]>([]);
    const [confirmLoading, setConfirmLoading] = useState(false);
    const [fileList, setFileList] = useState<UploadFile[]>([])
    const dispatch = useDispatch()
    const navigate = useNavigate()
    const { id } = useParams();
    const isDarkMode = useContext(MainContext) === 'true';
    const [form] = Form.useForm();

    // ── 草稿自动保存（localStorage）─────────────────────────────
    // 防止转跳 URL / 切换界面时未手动保存导致标题与正文丢失。
    // 按笔记 id 隔离：新笔记 note_draft_new，编辑 note_draft_{id}。
    const draftKey = 'note_draft_' + (id || 'new');
    const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const draftLatest = useRef({ title: '', content: '' });
    draftLatest.current = { title: noteTitle, content: noteContent };

    const saveDraftNow = () => {
        try {
            localStorage.setItem(draftKey, JSON.stringify({
                ...draftLatest.current,
                updatedAt: Date.now(),
            }));
        } catch (e) { /* localStorage 不可用时静默 */ }
    };

    // 内容变化 1.5s 后自动落盘
    useEffect(() => {
        if (draftTimer.current) clearTimeout(draftTimer.current);
        draftTimer.current = setTimeout(saveDraftNow, 1500);
        return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
    }, [noteTitle, noteContent]);

    // 组件卸载（转跳/切界面）时立即落盘，防止防抖未触发丢失最后输入
    useEffect(() => () => { saveDraftNow(); }, []);

    const restoreDraft = () => {
        try {
            const raw = localStorage.getItem(draftKey);
            if (!raw) return;
            const d = JSON.parse(raw);
            if (d && (d.title || d.content)) {
                setTitle(d.title || '');
                setNoteContent(d.content || '');
                if (d.title) form.setFieldValue('noteTitle', d.title);
                message.info('已恢复未保存的草稿内容');
            }
        } catch (e) { /* ignore */ }
    };

    const tagList = useSelector((state: {tags: any}) => state.tags.tag)
    const categories = useSelector((state: {categories: any}) => state.categories.categories);

    // Gallery Modal State
    const [galleryOpen, setGalleryOpen] = useState(false);
    const [galleryImages, setGalleryImages] = useState<any[]>([]);

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

    useEffect(() => {
        initNote()
    },[id])

    // 新笔记（无 id）：直接恢复未保存草稿
    useEffect(() => {
        if (!id) restoreDraft();
    }, [id])

    // Load images when gallery opens
    useEffect(() => {
        if (galleryOpen) {
            getImageList().then(res => {
                if(res.status === 200) {
                   setGalleryImages(Array.isArray(res?.data?.data) ? res.data.data : []);
                }
            });
        }
    }, [galleryOpen]);

    async function initNote(){
        if(id){
            try {
                const res = await getNoteById(id)
                form.setFieldsValue({
                    noteTitle: res.data.data.noteTitle,
                    noteCategory: res.data.data.noteCategory,
                    isTop: res.data.data.isTop,
                    status: res.data.data.status,
                    description: res.data.data.description,
                })
                setAiContent(res.data.data.description)
                setTitle(res.data.data.noteTitle)
                setNoteContent(res.data.data.noteContent)

                // Safe parsing of tags to avoid NaN
                const tagsStr = res.data.data.noteTags;
                let parsedTags: number[] = [];
                if (tagsStr && tagsStr.trim() !== '') {
                     parsedTags = tagsStr.split(',')
                        .map((tag: string) => parseInt(tag, 10))
                        .filter((num: number) => !isNaN(num));
                }
                setNoteTag(parsedTags);
                form.setFieldValue('noteTags', parsedTags);
                
                // Set cover if exists
                if(res.data.data.cover) {
                    setCoverImg(res.data.data.cover);
                    setFileList([{
                        uid: '-1',
                        name: 'Cover',
                        status: 'done',
                        url: resolveApiAssetUrl(res.data.data.cover),
                    }]);
                    form.setFieldValue('cover', [{
                        uid: '-1',
                        name: 'Cover',
                        status: 'done',
                        url: resolveApiAssetUrl(res.data.data.cover),
                    }]);
                }
                // 数据库内容加载完成后，再恢复未保存草稿（草稿优先，避免丢失上次编辑）
                restoreDraft();
            }catch (error){
                message.error("获取文章信息出错")
            }
        }
    }


    //回调函数区域
    const getAiContent = async () => {
        const openai = await generateResponse(noteContent)
        setAiContent(openai)
        form.setFieldValue('description', openai);
    }

    const upload = async (file: UploadFile) => {
        const compressedFile = await ImageCompression(file);
        const formData = new FormData();
        formData.append('file', compressedFile);
        const response = await uploadImages(formData)

        if(response.status ===200){
            setCoverImg(response.data.data)
            const newFile = {
                uid: file.uid,
                name: file.name,
                status: 'done' as const,
                url: resolveApiAssetUrl(response.data.data),
            };
            setFileList([newFile]);
            form.setFieldValue('cover', [newFile]);
        }
    }

    const showModal = async () => {
        setOpen(true);
        // Ensure noteTitle in form is up to date with state
        form.setFieldsValue({noteTitle: noteTitle});
    };

    const handleOk = async () => {
        try {
            // Validate first
            const values = await form.validateFields();
            setConfirmLoading(true);
            await onFinish(values);
            // setOpen(false); // Moved to onFinish logic to avoid closing on error
            setConfirmLoading(false);
        } catch (info) {
            console.log('Validate Failed:', info);
            setConfirmLoading(false);
        }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setTitle(e.target.value);
        form.setFieldValue('noteTitle', e.target.value);
    };

    const handleChange: UploadProps['onChange'] = ({ fileList: newFileList }) => {
        setFileList(newFileList);
        // Only trigger form change if it's empty, otherwise upload handles it
        if (newFileList.length === 0) {
             form.setFieldValue('cover', []);
             setCoverImg('');
        }
    };

    const handlePreview = async (file: UploadFile) => {
        let src = file.url as string;
        if (!src) {
            src = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.readAsDataURL(file.originFileObj as FileType);
                reader.onload = () => resolve(reader.result as string);
            });
        }
        const image = new Image();
        image.src = src;
        const imgWindow = window.open(src);
        imgWindow?.document.write(image.outerHTML);
    };
    const handleCancel = () => {
        setOpen(false);
    };

    const selectGalleryImage = (url: string) => {
        setCoverImg(url);
        const newFile = {
            uid: '-select-' + Date.now(),
            name: 'Gallery Image',
            status: 'done' as const,
            url: url
        };
        setFileList([newFile]);
        form.setFieldValue('cover', [newFile]);
        setGalleryOpen(false);
        message.success('已选择封面');
    };

    const onFinish = async (formValues: any) => {
        // Safe string conversion for tags
                const tagsData = formValues.noteTags;
        const tagsString = Array.isArray(tagsData) ? tagsData.join(',') : (tagsData || '');

        if (id) {
            const data = {
                noteTitle: formValues.noteTitle,
                noteContent: noteContent,
                cover: coverImg,
                description: aiContent,
                noteCategory: formValues.noteCategory,
                // @ts-ignore
                noteTags: tagsString,
                isTop: Number(formValues.isTop),
                status: formValues.status,
                updateTime: dayjs(new Date()).format('YYYY-MM-DD hh:mm:ss')
            }
            try {
                const res = await updateNote(id, data)
                if(res.status === 200){
                    dispatch<any>(fetchNoteList(true))
                    message.success("文章更新成功")
                    localStorage.removeItem(draftKey) // 发布成功清除草稿
                    setOpen(false); // Close modal
                    navigate('/dashboard/notes')
                }
            } catch (error) {
                message.error("文章更新失败：" + error)
            }
        } else {
            const data = {
                noteTitle: formValues.noteTitle,
                noteContent: noteContent,
                cover: coverImg,
                description: aiContent,
                noteCategory: formValues.noteCategory,
                // @ts-ignore
                noteTags: tagsString,
                isTop: Number(formValues.isTop),
                status: formValues.status,
                createTime: dayjs(new Date()).format('YYYY-MM-DD hh:mm:ss'),
                updateTime: dayjs(new Date()).format('YYYY-MM-DD hh:mm:ss')
            }
            try {
                const res = await createNote(data)
                if (res.status === 200) {
                    dispatch<any>(fetchNoteList(true))
                    message.success("文章创建成功")
                    localStorage.removeItem(draftKey) // 发布成功清除草稿
                    setOpen(false); // Close modal on create success
                    
                    // Reset fields
                    setNoteContent(' ')
                    setTitle('')
                    setNoteTag([])
                    setNoteContent('')
                    setAiContent('')
                    form.resetFields()
                    setFileList([])
                    setCoverImg('')
                }
            }catch (error){
                message.error("文章创建失败：")
            }
        }
    }
    const onChangeTag = (newTag: number[]) => {
        setNoteTag(newTag);
        form.setFieldValue('noteTags', newTag);
    };

    return <>
        <div className="notes-container">
            <div className="article_title">
                <label style={{width:115,fontSize:18,fontWeight:600}}>文章标题</label>
                <Input style={{background: 'transparent',border: '1px solid #4096ff',width: '95%',marginRight: 10, color: isDarkMode ? 'white' : 'black'}} onChange={handleInputChange} value={noteTitle}/>
                <Button type="primary" onClick={showModal} style={{float: "right"}}>
                    提交
                </Button>
            </div>
            <div className="new_article">
                <Editor_  setNoteContent={setNoteContent} noteContent={noteContent}/>
            </div>

            {/* Gallery Modal */}
            <Modal
                title="选择图库图片"
                open={galleryOpen}
                onCancel={() => setGalleryOpen(false)}
                footer={null}
                width={800}
            >
                <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
                    <Row gutter={[16, 16]}>
                        {galleryImages.map((img: any) => (
                            <Col span={6} key={img.imageKey}>
                                <Card
                                    hoverable
                                    cover={<img alt="example" src={resolveApiAssetUrl(img.imageUrl)} style={{ height: 100, objectFit: 'cover' }} />}
                                    onClick={() => selectGalleryImage(img.imageUrl)}
                                >
                                </Card>
                            </Col>
                        ))}
                    </Row>
                </div>
            </Modal>

            {/*文章创建*/}
            <Modal
                title="发布文章"
                open={open}
                onOk={handleOk}
                confirmLoading={confirmLoading}
                onCancel={handleCancel}
                okText="发布"
                cancelText="返回"
            >

                <Form {...formItemLayout} variant="filled" style={{ maxWidth: 600 }} form={form} onFinish={onFinish}>
                    <Form.Item label="文章标题" name="noteTitle" >
                        <Input disabled={true} />
                    </Form.Item>

                    <Form.Item
                        label="文章描述"
                        name="description"
                        rules={[{ required: true, message: 'Please input!' }]}
                    >
                        <Input.TextArea autoSize={{ minRows: 4, maxRows: 8 }} value={aiContent} onChange={(v) => {
                            setAiContent(v.target.value);
                            form.setFieldValue('description', v.target.value);
                        }}/>
                        <i className="iconfont icon-openai" style={{fontSize: 16,color:'#939ad8',position:'absolute',bottom: 5,right: 5,cursor:'pointer'}} onClick={getAiContent}></i>
                    </Form.Item>


                    <Form.Item label="文章分类" name="noteCategory" rules={[{ required: true, message: 'Please input!'}]}>
                        <Select>
                            {categories.map((item: { categoryTitle: string | number | boolean; categoryKey: number }) => (
                                <Select.Option value={item.categoryKey}>{item.categoryTitle}</Select.Option>
                            ))}
                        </Select>
                    </Form.Item>

                    <Form.Item
                        label="文章标签"
                        name="noteTags"
                        rules={[{ required: true, message: 'Please input!' }]}
                    >
                        <ConfigProvider
                            theme={{
                                components: {
                                    TreeSelect: {
                                    },
                                },
                            }}
                        >
                            <TreeSelect
                                placeholder="请选择文章标签"
                                showSearch
                                style={{ width: '100%' }}
                                dropdownStyle={{ maxHeight: 400, overflow: 'auto' }}
                                allowClear
                                multiple
                                treeDefaultExpandAll
                                treeData={tagList.map((tag: { tagKey: number; children: { tagKey: number; }[]; }) => ({
                                    ...tag,
                                    value: tag.tagKey,
                                    key: tag.tagKey,
                                    children: tag.children ? tag.children.map((child: { tagKey: number; }) => ({
                                        ...child,
                                        value: child.tagKey,
                                        key: child.tagKey
                                    })) : [] 
                                }))}
                                onChange={onChangeTag}
                                value={noteTag}
                            />
                        </ConfigProvider>
                    </Form.Item>

                    <Form.Item label="文章封面" >
                         <div style={{display: 'flex', gap: 10, alignItems: 'flex-start'}}>
                            <Form.Item name="cover" valuePropName="fileList" getValueFromEvent={(e) => {
                                if (Array.isArray(e)) {
                                    return e.slice(-1);
                                }
                                return e && e.fileList.slice(-1);
                            }} noStyle>
                                {/*@ts-ignore*/}
                                <Upload action={upload} listType="picture-card" fileList={fileList}
                                        onPreview={handlePreview}
                                        onChange={handleChange}>
                                    <button style={{ border: 0, background: 'none' }} type="button">
                                        <PlusOutlined />
                                        <div style={{ marginTop: 8 }}>Upload</div>
                                    </button>
                                </Upload>
                            </Form.Item>
                            
                            <Button icon={<PictureOutlined />} onClick={() => setGalleryOpen(true)}>
                                图库选择
                            </Button>
                         </div>
                    </Form.Item>

                    <Form.Item label="置顶" name='isTop' valuePropName="checked">
                        <Switch />
                    </Form.Item>

                    <Form.Item name="status" label="文章状态" rules={[{ required: true, message: 'Please input!' }]}>
                        <Radio.Group>
                            <Radio value="public">公开</Radio>
                            <Radio value="private">私密</Radio>
                            <Radio value="draft">草稿</Radio>
                        </Radio.Group>
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    </>
}

export default NewNotes;
