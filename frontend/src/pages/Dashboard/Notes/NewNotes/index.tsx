import Editor_, {type EditorHandle} from "../../../../components/Editor";
import ArticleCollaboration from '../../../../components/ArticleCollaboration';
import './index.sass'
import {
    Alert, Button,
    Input,
    Form,
    Modal,
    Select,
    Upload, Switch, Radio, UploadProps, UploadFile, GetProp, message, Row, Col, Card, Empty, Spin
} from "antd";
import {PlusOutlined, PictureOutlined, EditOutlined} from "@ant-design/icons";
import React, {useEffect,  useState, useRef} from "react";
import dayjs from "dayjs";
import {useDispatch, useSelector} from "react-redux";
import {useNavigate, useParams} from "react-router-dom";
import {updateNote, delNote, autosaveDraft, getNoteForEdit, type AutosaveDraftPayload} from "../../../../apis/NoteMethods.tsx";
import getToken from "../../../../apis/getToken.tsx";
import {ok, errMsg} from "../../../../apis/ProfileMethods.tsx";
import {postDraftKeepalive} from "./draftTransport";
import ImageCompression from "../../../../apis/ImageCompression.tsx";
import {uploadImages} from "../../../../apis/ImageMethods.tsx";
import {assetDisplayName} from '../../../../utils/assetName';
import { resolveApiAssetUrl, runtimeBaseURL } from '../../../../utils/runtimeApi';
import {useGalleryPager} from "../../../../utils/galleryPager.ts";
import CoverCropModal from '../../../../components/CoverCropModal';
import NoteTagSelect from '../../../../components/NoteTagSelect/index.tsx';
import {adminNotesApi} from "../../../../apis/adminNotesApi";
import {readListReturn} from '../AllNotes/listState';
import { DEFAULT_CROP, carouselCropFromRow, cropFromRow, type CoverCrop } from '../../../../utils/coverCrop';

type FileType = Parameters<GetProp<UploadProps, 'beforeUpload'>>[0];


const NewNotes = () => {
    const [open, setOpen] = useState(false);
    const [noteTitle,setTitle] = useState('')
    const [noteContent, setNoteContent] = useState('')
    const [coverImg,setCoverImg] = useState('')
    const [coverCrop, setCoverCrop] = useState<CoverCrop>({...DEFAULT_CROP})
    const [coverCropCarousel, setCoverCropCarousel] = useState<CoverCrop>({...DEFAULT_CROP})
    const [cropDirty, setCropDirty] = useState({carousel: false, card: false})
    const [cropOpen, setCropOpen] = useState(false)
    const cropSnap = useRef<{carousel: CoverCrop; card: CoverCrop}>({carousel: {...DEFAULT_CROP}, card: {...DEFAULT_CROP}})
    const [aiContent,setAiContent] = useState('')
    const [noteTag, setNoteTag] = useState<number[]>([]);
    const [confirmLoading, setConfirmLoading] = useState(false);
    const [fileList, setFileList] = useState<UploadFile[]>([])
    const dispatch = useDispatch()
    const navigate = useNavigate()
    const { id } = useParams();
    const [form] = Form.useForm();
    const AUTOSAVE_DELAY = 2000;
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle');
    const [savedAt, setSavedAt] = useState('');
    const [isRevision, setIsRevision] = useState(false); // 正在编辑的是原文章的修改稿
    const [hydrated, setHydrated] = useState(false);

    const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savedIdRef = useRef<string | undefined>(id);   // 最新 id（绕开闭包过期）
    const lastSavedRef = useRef('');                     // 上次「确实写进库里」的快照串
    const createdHereRef = useRef(false);                // 本次会话自动建出来的草稿行
    const hydratedRef = useRef(false);
    const seededRef = useRef(false);
    const stopAutosaveRef = useRef(false);               // 已发布 → 关掉自动保存
    const publishingRef = useRef(false);                 // 提交请求在途 → 暂停自动保存
    const inFlightRef = useRef<Promise<unknown> | null>(null); // 单飞：至多一个自动保存在途
    const queuedRef = useRef<string | null>(null);       // 在途期间攒下的最新快照（尾随补发）
    const retryRef = useRef(0);
    const mountedRef = useRef(true);
    const sessionTokenRef = useRef(getToken());
    const detachedPayloadRef = useRef<AutosaveDraftPayload | null>(null);
    const versionRef = useRef<string | undefined>(undefined);
    const conflictedRef = useRef(false);
    const editorRef = useRef<EditorHandle>(null);
    const isBlank = (s: string) =>
        (s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === '';
    const buildPayload = (): AutosaveDraftPayload => {
        const cat = form.getFieldValue('noteCategory');
        const top = form.getFieldValue('isTop');
        return {
            id: savedIdRef.current ? Number(savedIdRef.current) : null,
            noteTitle: noteTitle,
            noteContent: editorRef.current?.read() ?? noteContent,
            cover: coverImg,
            coverFocusX: coverImg ? coverCrop.x : null,
            coverFocusY: coverImg ? coverCrop.y : null,
            coverZoom: coverImg ? coverCrop.z : null,
            coverFit: coverImg ? (coverCrop.fit ?? 'cover') : null,
            carouselFocusX: coverImg && cropDirty.carousel ? coverCropCarousel.x : null,
            carouselFocusY: coverImg && cropDirty.carousel ? coverCropCarousel.y : null,
            carouselZoom: coverImg && cropDirty.carousel ? coverCropCarousel.z : null,
            carouselFit: coverImg && cropDirty.carousel ? (coverCropCarousel.fit ?? 'cover') : null,
            description: aiContent,
            noteCategory: cat === undefined || cat === null ? null : Number(cat),
            noteTags: noteTag.join(','),
            isTop: top === undefined ? undefined : Number(top),
        };
    };
    const buildPayloadRef = useRef(buildPayload);
    buildPayloadRef.current = buildPayload;
    const latestPayload = (): AutosaveDraftPayload => ({
        ...(detachedPayloadRef.current ?? buildPayloadRef.current()),
        id: savedIdRef.current ? Number(savedIdRef.current) : null,
    });

    const onAutosaveFail = () => {
        if (mountedRef.current) setSaveState('error');
        if (mountedRef.current && retryRef.current < 3) { // 断网/接口抖动：5s 后重试，最多 3 次
            retryRef.current += 1;
            if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
            autosaveTimer.current = setTimeout(() => flushAutosave(false), 5000);
        }
    };

    const flushAutosave = (beacon = false) => {
        if (!hydratedRef.current || stopAutosaveRef.current || publishingRef.current || conflictedRef.current
            || getToken() !== sessionTokenRef.current) return;
        if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }

        const payload = latestPayload();
        const blank = isBlank(payload.noteTitle || '') && isBlank(payload.noteContent || '') && isBlank(payload.description || '');
        if (!payload.id && blank) return;         // 新建且还没写进任何东西 → 不建空行
        const ser = JSON.stringify(payload);
        if (ser === lastSavedRef.current) return; // 没真变化 → 不发请求
        if (inFlightRef.current) { queuedRef.current = ser; return; }

        if (mountedRef.current) setSaveState('saving');
        const requestPayload = {...payload, expectedVersion: versionRef.current};
        const request = beacon
            ? postDraftKeepalive(requestPayload, runtimeBaseURL, sessionTokenRef.current)
            : autosaveDraft(requestPayload);
        inFlightRef.current = request.then(res => {
            if (getToken() !== sessionTokenRef.current) return;
            const d = res?.data?.data;
            if (res?.data?.code === 409) {
                conflictedRef.current = true;
                queuedRef.current = null;
                if (mountedRef.current) setSaveState('conflict');
                return;
            }
            if (ok(res) && Number.isInteger(d?.id) && d.id > 0 && typeof d.version === 'string') {
                versionRef.current = d.version;
                lastSavedRef.current = JSON.stringify({...payload, id: d.id});
                if (!savedIdRef.current) createdHereRef.current = true;
                savedIdRef.current = String(d.id);
                retryRef.current = 0;
                if (mountedRef.current) {
                    setIsRevision(!!d.isRevision);
                    setSaveState('saved');
                    setSavedAt((d.updateTime || '').slice(11));
                }
            } else if (beacon) {
                if (mountedRef.current) setSaveState('error');
            } else {
                onAutosaveFail();
            }
        }).catch(() => {
            if (beacon) {
                if (mountedRef.current) setSaveState('error');
            } else onAutosaveFail();
        }).finally(() => {
            inFlightRef.current = null;
            if (queuedRef.current) { queuedRef.current = null; flushAutosave(false); }
        });
    };
    const scheduleAutosave = () => {
        if (!hydratedRef.current || stopAutosaveRef.current || publishingRef.current || conflictedRef.current
            || getToken() !== sessionTokenRef.current) return;
        if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
        autosaveTimer.current = setTimeout(() => flushAutosave(false), AUTOSAVE_DELAY);
    };
    useEffect(() => {
        if (!hydrated || seededRef.current) return;
        seededRef.current = true;
        lastSavedRef.current = JSON.stringify(buildPayload());
        hydratedRef.current = true;
    }, [hydrated, noteTitle, noteContent, coverImg, aiContent, noteTag, coverCrop, coverCropCarousel, cropDirty]);
    useEffect(() => {
        scheduleAutosave();
    }, [noteTitle, noteContent, coverImg, aiContent, noteTag, coverCrop, coverCropCarousel, cropDirty]);

    useEffect(() => {
        mountedRef.current = true;
        detachedPayloadRef.current = null;
        return () => { mountedRef.current = false; };
    }, []);
    useEffect(() => () => {
        if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
        if (stopAutosaveRef.current || getToken() !== sessionTokenRef.current) return;
        const p = buildPayloadRef.current();
        detachedPayloadRef.current = {...p};
        if (createdHereRef.current && savedIdRef.current
            && isBlank(p.noteTitle || '') && isBlank(p.noteContent || '') && isBlank(p.description || '')) {
            if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
            delNote(Number(savedIdRef.current));
            return;
        }
        flushAutosave(false);
    }, []);
    useEffect(() => {
        const onHide = () => { if (!stopAutosaveRef.current) flushAutosave(true); };
        const onResume = () => {
            if (!document.hidden) { retryRef.current = 0; flushAutosave(false); }
        };
        window.addEventListener('pagehide', onHide);
        window.addEventListener('pageshow', onResume);
        document.addEventListener('visibilitychange', onResume);
        return () => {
            window.removeEventListener('pagehide', onHide);
            window.removeEventListener('pageshow', onResume);
            document.removeEventListener('visibilitychange', onResume);
        };
    }, []);

    const categories = useSelector((state: {categories: any}) => state.categories.categories);

    const [galleryOpen, setGalleryOpen] = useState(false);
    const { images: galleryImages, loading: galleryLoading, loadingMore: galleryLoadingMore,
            error: galleryError, pageError: galleryPageError, hasMore: galleryHasMore, reload: reloadGallery, loadMore: loadMoreGallery } = useGalleryPager(galleryOpen);

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
        if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
        savedIdRef.current = id;
        createdHereRef.current = false;
        stopAutosaveRef.current = false;
        publishingRef.current = false;
        inFlightRef.current = null;
        queuedRef.current = null;
        seededRef.current = false;
        hydratedRef.current = false;
        retryRef.current = 0;
        detachedPayloadRef.current = null;
        setHydrated(false);
        setIsRevision(false);
        setSaveState('idle');
        initNote()
        if (!id) setHydrated(true)
    },[id])

    async function initNote(){
        if(id){
            try {
                const res = await getNoteForEdit(id)
                const data = res.data.data
                if (!ok(res) || typeof data?.version !== 'string') throw new Error('无效草稿版本')
                versionRef.current = data.version
                const row = data.draft ?? data.note
                setIsRevision(!!data.draft)
                form.setFieldsValue({
                    noteTitle: row.noteTitle,
                    noteCategory: row.noteCategory,
                    isTop: row.isTop,
                    // Publish controls use the root status, not the shadow draft status.
                    status: data.note.status,
                    description: row.description,
                })
                setAiContent(row.description || '')
                setTitle(row.noteTitle)
                setNoteContent(row.noteContent)

                const tagsStr = row.noteTags;
                let parsedTags: number[] = [];
                if (tagsStr && tagsStr.trim() !== '') {
                     parsedTags = tagsStr.split(',')
                        .map((tag: string) => parseInt(tag, 10))
                        .filter((num: number) => !isNaN(num));
                }
                setNoteTag(parsedTags);
                form.setFieldValue('noteTags', parsedTags);

                if(row.cover) {
                    setCoverImg(row.cover);
                    setCoverCrop(cropFromRow(row) ?? {...DEFAULT_CROP});
                    setCoverCropCarousel(carouselCropFromRow(row) ?? cropFromRow(row) ?? {...DEFAULT_CROP});
                    setCropDirty({carousel: false, card: false});
                    setFileList([{
                        uid: '-1',
                        name: 'Cover',
                        status: 'done',
                        url: resolveApiAssetUrl(row.cover),
                    }]);
                    form.setFieldValue('cover', [{
                        uid: '-1',
                        name: 'Cover',
                        status: 'done',
                        url: resolveApiAssetUrl(row.cover),
                    }]);
                }
                setHydrated(true) // 回填完毕，此后才允许自动保存
            }catch{
                message.error("获取文章信息出错")
            }
        }
    }



    const openCropper = (fresh: boolean) => {
        cropSnap.current = fresh
            ? {carousel: {...DEFAULT_CROP}, card: {...DEFAULT_CROP}}
            : {carousel: coverCropCarousel, card: coverCrop};
        if (fresh) {
            setCoverCrop({...DEFAULT_CROP});
            setCoverCropCarousel({...DEFAULT_CROP});
            setCropDirty({carousel: true, card: true});
        }
        setCropOpen(true);
    };

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
            openCropper(true);
        }
    }

    const showModal = async () => {
        setOpen(true);
        form.setFieldsValue({noteTitle: noteTitle});
    };

    const preparePublication = () => {
        if (!hydratedRef.current || conflictedRef.current || publishingRef.current)
            throw new Error('草稿未就绪、存在冲突或正在提交，请稍后重试。');
        form.setFieldsValue({noteTitle, description: aiContent, status: 'public'});
        setOpen(true);
    };

    const handleOk = async () => {
        try {
            const values = await form.validateFields();
            setConfirmLoading(true);
            await onFinish(values);
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
        if (newFileList.length === 0) {
             form.setFieldValue('cover', []);
             setCoverImg('');
             setCoverCrop({...DEFAULT_CROP});
             setCoverCropCarousel({...DEFAULT_CROP});
             setCropDirty({carousel: true, card: true});
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
        imgWindow?.document.body?.appendChild(image.cloneNode() as HTMLImageElement);
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
        openCropper(true);
    };

    const onFinish = async (formValues: any) => {
        if (conflictedRef.current) {
            message.error('草稿存在版本冲突，请保留当前内容并重新打开文章后合并');
            return;
        }
        if (publishingRef.current) return;
        publishingRef.current = true; // 同帧互斥，挡住重复点击/回车提交
        const tagsData = formValues.noteTags;
        const tagsString = Array.isArray(tagsData) ? tagsData.join(',') : (tagsData || '');

        const now = dayjs(new Date()).format('YYYY-MM-DD HH:mm:ss');
        const data = {
            noteTitle: formValues.noteTitle,
            noteContent: editorRef.current?.read() ?? noteContent,
            cover: coverImg,
            coverFocusX: coverImg ? coverCrop.x : null,
            coverFocusY: coverImg ? coverCrop.y : null,
            coverZoom: coverImg ? coverCrop.z : null,
            coverFit: coverImg ? (coverCrop.fit ?? 'cover') : null,
            // Send carousel coordinates together; null keeps the card fallback.
            carouselFocusX: coverImg && cropDirty.carousel ? coverCropCarousel.x : null,
            carouselFocusY: coverImg && cropDirty.carousel ? coverCropCarousel.y : null,
            carouselZoom: coverImg && cropDirty.carousel ? coverCropCarousel.z : null,
            carouselFit: coverImg && cropDirty.carousel ? (coverCropCarousel.fit ?? 'cover') : null,
            description: aiContent,
            noteCategory: formValues.noteCategory,
            noteTags: tagsString,
            isTop: Number(formValues.isTop),
            status: formValues.status,
            updateTime: now
        }

        const submittedPayload = {...buildPayload(), noteCategory: Number(formValues.noteCategory),
            noteTags: tagsString, isTop: Number(formValues.isTop)};
        publishingRef.current = true;
        if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
        if (inFlightRef.current) { try { await inFlightRef.current; } catch { /* 在途错误已记录 */ } }
        if (conflictedRef.current) {
            publishingRef.current = false;
            message.error('草稿已在其他位置更新，本次没有发布。请先核对并合并。');
            return;
        }
        if (getToken() !== sessionTokenRef.current) {
            publishingRef.current = false;
            message.error("登录状态已变化，请重新打开编辑页");
            return;
        }
        let targetId = savedIdRef.current;
        if (!targetId) {
            try {
                const r = await autosaveDraft(submittedPayload);
                if (getToken() !== sessionTokenRef.current) throw new Error("登录状态已变化");
                const newId = r?.data?.data?.id;
                if (ok(r) && Number.isInteger(newId) && newId > 0) {
                    versionRef.current = r.data.data.version;
                    targetId = String(newId);
                    savedIdRef.current = targetId;
                } else throw new Error(errMsg(r, "草稿创建失败"));
            } catch (error) {
                publishingRef.current = false;
                scheduleAutosave();
                message.error("草稿尚未确认保存，请稍后重试：" + error);
                return;
            }
        }

        const snapBeforePublish = JSON.stringify({...submittedPayload, id: Number(targetId)});

        try {
            if (targetId) {
                const res = await updateNote(targetId, {...data, expectedVersion: versionRef.current})
                if (ok(res)) {
                    dispatch(adminNotesApi.util.invalidateTags(['AdminNotes', 'AdminNoteCount']));
                    const stayInEditor = data.status === 'draft';
                    message.success(stayInEditor ? "已保存到草稿箱" : "文章更新成功")
                    setOpen(false);
                    if (stayInEditor) {
                        const refreshed = await getNoteForEdit(targetId);
                        if (!ok(refreshed) || typeof refreshed.data.data?.version !== 'string')
                            throw new Error('保存成功，但无法读取最新草稿版本，请重新打开文章');
                        versionRef.current = refreshed.data.data.version;
                        // Acknowledge only the submitted snapshot; later edits still need autosaving.
                        publishingRef.current = false;
                        if (JSON.stringify(buildPayloadRef.current()) === snapBeforePublish) {
                            lastSavedRef.current = snapBeforePublish;
                        } else {
                            scheduleAutosave();
                        }
                    } else {
                        stopAutosaveRef.current = true;
                        if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
                        goBackToList()
                    }
                } else {
                    if (res.data?.code === 409) {
                        conflictedRef.current = true;
                        setSaveState('conflict');
                    }
                    message.error(errMsg(res, "文章保存失败"));
                    publishingRef.current = false; // 业务失败：放开自动保存并把内容补写回去
                    scheduleAutosave();
                }
            }
        } catch (error) {
            publishingRef.current = false;
            scheduleAutosave();
            message.error("文章保存失败：" + error)
        }
    }
    const goBackToList = () => {
        const ticket = readListReturn();
        if (ticket !== null) {
            const qs = ticket === '' ? '' : (ticket.startsWith('?') ? ticket : `?${ticket}`);
            navigate(`/dashboard/notes${qs}`, {replace: true});
            return;
        }
        const idx = (window.history.state as {idx?: unknown} | null)?.idx;
        if (typeof idx === 'number' && idx > 0) {
            navigate(-1);
            return;
        }
        navigate('/dashboard/notes', {replace: true});
    };

    const onChangeTag = (newTag: number[]) => {
        setNoteTag(newTag);
        form.setFieldValue('noteTags', newTag);
    };

    return <>
        <div className="notes-container">
            <div className="article-toolbar">
                <Button type="primary" onClick={showModal}>
                    提交
                </Button>
                <span style={{
                    float: 'right',
                    marginRight: 12,
                    lineHeight: '32px',
                    fontSize: 12,
                    color: saveState === 'error' || saveState === 'conflict' ? '#c43868' : '#999',
                }}>
                    {saveState === 'saving' ? '草稿保存中…'
                        : saveState === 'conflict' ? '草稿已在其他位置更新，已停止覆盖；请保留当前内容并重新打开后合并'
                        : saveState === 'error' ? '草稿保存失败，稍后自动重试'
                        : saveState === 'saved' ? `草稿已自动保存 ${savedAt}`
                        : ''}
                </span>
            </div>
            {isRevision && (
                <div style={{margin: '4px 0 8px', fontSize: 12, color: '#999'}}>
                    正在编辑修改稿：原文章线上内容保持不变，点「提交」发布后才覆盖
                </div>
            )}
            <ArticleCollaboration title={noteTitle} content={noteContent} description={aiContent}
                ready={hydrated} blocked={saveState === 'conflict' || confirmLoading}
                readBody={() => editorRef.current?.read() ?? noteContent}
                onBody={content => editorRef.current?.apply(content)}
                onTitle={title => {setTitle(title); form.setFieldValue('noteTitle', title)}}
                onPreparePublish={preparePublication}
                onSummary={description => {setAiContent(description); form.setFieldValue('description', description)}}/>
            <div className="new_article">
                <Editor_ editorRef={editorRef} setNoteContent={setNoteContent} noteContent={noteContent}/>
            </div>

            <Modal
                title="选择图库图片"
                open={galleryOpen}
                onCancel={() => setGalleryOpen(false)}
                footer={null}
                width={800}
            >
                <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
                    {galleryLoading ? (
                        <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
                    ) : galleryError ? (
                        <Alert type="error" showIcon message={galleryError} action={<Button onClick={()=>void reloadGallery()}>重试</Button>}/>
                    ) : galleryImages.length === 0 ? (
                        <Empty description="图库里还没有图片，可以去「图库」页传一张" />
                    ) : (
                        <>
                            <Row gutter={[16, 16]}>
                                {galleryImages.map((img) => (
                                    <Col span={6} key={img.imageKey}>
                                        <Card
                                            hoverable
                                            cover={<img alt={img.displayName||assetDisplayName(img.imageUrl)} src={resolveApiAssetUrl(img.imageUrl)} style={{ height: 100, objectFit: 'cover' }} />}
                                            onClick={() => selectGalleryImage(img.imageUrl)}
                                        >
                                            <Card.Meta title={img.displayName||assetDisplayName(img.imageUrl)}/>
                                        </Card>
                                    </Col>
                                ))}
                            </Row>
                            {galleryPageError&&<Alert type="error" showIcon message={galleryPageError} action={<Button onClick={()=>void reloadGallery()}>重试</Button>}/>}
                            {galleryHasMore && (
                                <div style={{ textAlign: 'center', marginTop: 12 }}>
                                    <Button type="link" loading={galleryLoadingMore} onClick={() => { void loadMoreGallery() }}>
                                        载入更多
                                    </Button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </Modal>

            <Modal
                title="发布文章"
                open={open}
                onOk={handleOk}
                confirmLoading={confirmLoading}
                onCancel={handleCancel}
                okText="发布"
                cancelText="返回"
            >

                <Form {...formItemLayout} variant="filled" style={{ maxWidth: 600 }} form={form} onFinish={onFinish}
                      onValuesChange={() => scheduleAutosave()}>
                    <Form.Item label="文章标题" name="noteTitle"
                        rules={[{required: true, whitespace: true, message: '请输入文章标题'},
                            {max: 255, message: '标题最多 255 字'}]}>
                        <Input maxLength={255} onChange={handleInputChange} />
                    </Form.Item>

                    <Form.Item
                        label="文章描述"
                        name="description"
                    >
                        <Input.TextArea autoSize={{ minRows: 4, maxRows: 8 }} value={aiContent} onChange={(v) => {
                            setAiContent(v.target.value);
                            form.setFieldValue('description', v.target.value);
                        }}/>
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
                    >
                        <NoteTagSelect onChange={onChangeTag} value={noteTag} />
                    </Form.Item>

                    <Form.Item label="文章封面" >
                         <div style={{display: 'flex', gap: 10, alignItems: 'flex-start'}}>
                            <Form.Item name="cover" valuePropName="fileList" getValueFromEvent={(e) => {
                                if (Array.isArray(e)) {
                                    return e.slice(-1);
                                }
                                return e && e.fileList.slice(-1);
                            }} noStyle>
                                {/* @ts-ignore */}
                                <Upload action={upload} listType="picture-card" fileList={fileList}
                                        onPreview={handlePreview}
                                        onChange={handleChange}>
                                    <button style={{ border: 0, background: 'none' }} type="button">
                                        <PlusOutlined />
                                        <div style={{ marginTop: 8 }}>Upload</div>
                                    </button>
                                </Upload>
                            </Form.Item>
                            
                            <div style={{display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start'}}>
                                <Button icon={<PictureOutlined />} onClick={() => setGalleryOpen(true)}>
                                    图库选择
                                </Button>
                                <Button icon={<EditOutlined />} disabled={!coverImg} onClick={() => openCropper(false)}>
                                    调整裁剪
                                </Button>
                            </div>
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

            <CoverCropModal
                open={cropOpen}
                src={coverImg}
                initialCarousel={coverCropCarousel}
                initialCard={coverCrop}
                onCancel={() => {
                    setCoverCrop(cropSnap.current.card);
                    setCoverCropCarousel(cropSnap.current.carousel);
                    setCropOpen(false);
                }}
                onConfirm={(r) => {
                    setCoverCrop(r.card);
                    setCoverCropCarousel(r.carousel);
                    setCropDirty(d => ({carousel: d.carousel || r.dirty.carousel, card: d.card || r.dirty.card}));
                    setCropOpen(false);
                }}
            />
        </div>
    </>
}

export default NewNotes;
