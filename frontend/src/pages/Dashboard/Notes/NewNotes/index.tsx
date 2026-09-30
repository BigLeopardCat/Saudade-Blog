import Editor_ from "../../../../components/Editor";
import './index.sass'
import {
    Button,
    Input,
    Form,
    Modal,
    Select,
    Upload, Switch, Radio, UploadProps, UploadFile, GetProp, message, Row, Col, Card
} from "antd";
import {PlusOutlined, PictureOutlined, EditOutlined} from "@ant-design/icons";
import React, {useEffect,  useState, useRef} from "react";
import dayjs from "dayjs";
import {useDispatch, useSelector} from "react-redux";
import {useNavigate, useParams} from "react-router-dom";
import {fetchNoteList} from "../../../../store/components/note.tsx";
import {createNote, updateNote, delNote, autosaveDraft, getNoteForEdit, type AutosaveDraftPayload} from "../../../../apis/NoteMethods.tsx";
import getToken from "../../../../apis/getToken.tsx";
import ImageCompression from "../../../../apis/ImageCompression.tsx";
import {uploadImages, getImageList} from "../../../../apis/ImageMethods.tsx";
import { resolveApiAssetUrl, runtimeBaseURL } from '../../../../utils/runtimeApi';
import CoverCropModal from '../../../../components/CoverCropModal';
import NoteTagSelect from '../../../../components/NoteTagSelect/index.tsx';
import {readListReturn} from '../AllNotes/listState';
import { DEFAULT_CROP, carouselCropFromRow, cropFromRow, isDefaultCrop, type CoverCrop } from '../../../../utils/coverCrop';

type FileType = Parameters<GetProp<UploadProps, 'beforeUpload'>>[0];


const NewNotes = () => {
    //hooks区域
    //文章提交表单
    const [open, setOpen] = useState(false);
    const [noteTitle,setTitle] = useState('')
    const [noteContent, setNoteContent] = useState('')
    const [coverImg,setCoverImg] = useState('')
    // 封面裁剪参数（焦点+缩放）：上传/选图后弹裁剪窗，确认才写回；取消还原打开前的快照。
    // 两套参数：coverCrop = 文章卡片那套（详情页横幅同用，有封面就总是回传）；
    // coverCropCarousel = 置顶轮播那套（只在用户动过/换过图时才回传，
    // 否则后端保持 NULL → 轮播继续跟随卡片那套，存量文章零回归）
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

    // ── 编辑草稿自动保存（服务端，落到草稿箱）─────────────────────
    // 停止输入 AUTOSAVE_DELAY 后自动落库：新建文章 → 草稿箱里多一行独立草稿；
    // 编辑草稿 → 原地更新；编辑已发布/私密文章 → 落到它的「修改稿」行（原文章线上内容一个字
    // 不动，点「提交」发布时才覆盖）。转跳 URL/切界面时立刻补一次，关标签页时尽力再补一次。
    // 打开编辑页直接回填服务端草稿，不再有本机草稿与「是否恢复」提示——旧的 localStorage 那套
    // 已整体移除：它保存成功后 removeItem，紧接着 navigate 触发的卸载又写回，草稿永远清不掉，
    // 二次进编辑页必弹恢复提示，而且换设备就丢。
    const AUTOSAVE_DELAY = 2000;

    // 实际在编辑的文章 id：编辑页 = 路由 id；新建页首次自动保存建出草稿行后就地采纳它的 id。
    // 采纳后**不改 URL**——路由参数一变，下面 [id] 的 effect 会重跑 initNote，把编辑器内容整片
    // 覆盖成服务端值，正在敲的字会当场消失。
    const [editId, setEditId] = useState<string | undefined>(id);
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [savedAt, setSavedAt] = useState('');
    const [isRevision, setIsRevision] = useState(false); // 正在编辑的是原文章的修改稿
    const [hydrated, setHydrated] = useState(false);     // 服务端内容已回填完（此前禁止自动保存）

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

    // 空内容判定：编辑器空态是 <p></p> 这类空标签，去标签去空白后为空才算空
    const isBlank = (s: string) =>
        (s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === '';

    // 自动保存载荷：每次 render 重建（同 draftLatest 的手法），卸载/隐藏时也取得到最新值
    const buildPayload = (): AutosaveDraftPayload => {
        const cat = form.getFieldValue('noteCategory');
        const top = form.getFieldValue('isTop');
        return {
            id: savedIdRef.current ? Number(savedIdRef.current) : null,
            noteTitle: noteTitle,
            noteContent: noteContent,
            cover: coverImg,
            coverFocusX: coverImg ? coverCrop.x : null,
            coverFocusY: coverImg ? coverCrop.y : null,
            coverZoom: coverImg ? coverCrop.z : null,
            // 轮播那套与提交时同规则：动过才回传（三列同进同出），否则保持 NULL 走回退链
            carouselFocusX: coverImg && cropDirty.carousel ? coverCropCarousel.x : null,
            carouselFocusY: coverImg && cropDirty.carousel ? coverCropCarousel.y : null,
            carouselZoom: coverImg && cropDirty.carousel ? coverCropCarousel.z : null,
            description: aiContent,
            noteCategory: cat === undefined || cat === null ? null : Number(cat),
            noteTags: noteTag.join(','),
            isTop: top === undefined ? undefined : Number(top),
        };
    };
    const buildPayloadRef = useRef(buildPayload);
    buildPayloadRef.current = buildPayload;

    // 关标签页/刷新：来不及走 axios，用小体积 keepalive fetch 尽力补一发
    // （sendBeacon 不能带 Authorization 头，keepalive fetch 可以；上限 64KB，超了只能放弃）
    const postKeepalive = (payload: AutosaveDraftPayload) => {
        try {
            const body = JSON.stringify(payload);
            if (body.length > 60000) return;
            const token = getToken();
            fetch(`${runtimeBaseURL}/api/protected/draft/autosave`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? {Authorization: token.startsWith('Bearer ') ? token : 'Bearer ' + token} : {}),
                },
                body,
                keepalive: true,
            }).catch(() => { /* 尽力而为 */ });
        } catch (e) { /* ignore */ }
    };

    const onAutosaveFail = () => {
        // 不碰 lastSavedRef（只有成功才认账）：失败后内容仍与基准不同，重试时自然重发
        if (mountedRef.current) setSaveState('error');
        if (retryRef.current < 3) { // 断网/接口抖动：5s 后重试，最多 3 次
            retryRef.current += 1;
            if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
            autosaveTimer.current = setTimeout(() => flushAutosave(false), 5000);
        }
    };

    const flushAutosave = (beacon = false) => {
        if (!hydratedRef.current || stopAutosaveRef.current || publishingRef.current) return;
        if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }

        const payload = buildPayloadRef.current();
        const blank = isBlank(payload.noteTitle || '') && isBlank(payload.noteContent || '');
        if (!payload.id && blank) return;         // 新建且还没写进任何东西 → 不建空行
        const ser = JSON.stringify(payload);
        if (ser === lastSavedRef.current) return; // 没真变化 → 不发请求

        if (beacon) {                             // 关标签页：最后一发，不等回执
            lastSavedRef.current = ser;
            postKeepalive(payload);
            return;
        }
        // 单飞：已有请求在途时只记下最新快照，等它回来再补发。
        // 不这样做的话，新建文章（id 还是 null）在首个请求回来前继续敲字会再发一发 id=null，
        // 服务端各建一行 —— 草稿箱里凭空多一行同内容草稿，正是这次要修的毛病。
        if (inFlightRef.current) { queuedRef.current = ser; return; }

        setSaveState('saving');
        inFlightRef.current = autosaveDraft(payload).then(res => {
            const d = res?.data?.data;
            if (res.status === 200 && d?.id) {
                lastSavedRef.current = ser;
                if (!savedIdRef.current) { setEditId(String(d.id)); createdHereRef.current = true; }
                savedIdRef.current = String(d.id);
                setIsRevision(!!d.isRevision);
                retryRef.current = 0;
                if (mountedRef.current) {
                    setSaveState('saved');
                    setSavedAt((d.updateTime || '').slice(11));
                }
            } else {
                onAutosaveFail();
            }
        }).catch(() => onAutosaveFail()).finally(() => {
            inFlightRef.current = null;
            if (queuedRef.current) { queuedRef.current = null; flushAutosave(false); }
        });
    };

    // 停止输入 2s 后落盘
    const scheduleAutosave = () => {
        if (!hydratedRef.current || stopAutosaveRef.current || publishingRef.current) return;
        if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
        autosaveTimer.current = setTimeout(() => flushAutosave(false), AUTOSAVE_DELAY);
    };

    // 回填完毕后把当前内容记为「已保存」，否则刚打开页面就会把服务端内容原样回写一遍。
    // 必须在 hydrated 翻转后的那一次 render 才跑——此时 buildPayload 才读到回填后的值。
    useEffect(() => {
        if (!hydrated || seededRef.current) return;
        seededRef.current = true;
        lastSavedRef.current = JSON.stringify(buildPayload());
        hydratedRef.current = true;
    }, [hydrated, noteTitle, noteContent, coverImg, aiContent, noteTag, coverCrop, coverCropCarousel, cropDirty]);

    // 编辑内容一变就排一次自动保存（表单里的分类/置顶/描述另由 Form 的 onValuesChange 触发）
    useEffect(() => {
        scheduleAutosave();
    }, [noteTitle, noteContent, coverImg, aiContent, noteTag, coverCrop, coverCropCarousel, cropDirty]);

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    // 转跳 URL/切界面（组件卸载）：立刻补一次，别等防抖；本次会话新建且一直空白的行顺手删掉
    useEffect(() => () => {
        if (stopAutosaveRef.current) return;
        const p = buildPayloadRef.current();
        if (createdHereRef.current && savedIdRef.current
            && isBlank(p.noteTitle || '') && isBlank(p.noteContent || '')) {
            if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
            delNote(Number(savedIdRef.current));
            return;
        }
        flushAutosave(false);
    }, []);

    // 关标签页/刷新/切到后台：尽力补一发
    useEffect(() => {
        const onHide = () => { if (!stopAutosaveRef.current) flushAutosave(true); };
        window.addEventListener('pagehide', onHide);
        return () => window.removeEventListener('pagehide', onHide);
    }, []);

    // 标签字典现在由 NoteTagSelect 自己从 redux 取（编辑器不再直接读 tagList）
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

    // 换文章（首次进入 / 从草稿箱点另一篇）：先把自动保存的身份与守卫重置回未回填态，
    // 否则上一篇待发的自动保存会带着旧内容写到新文章上；新建页没有服务端内容要回填，直接放行。
    // 路由在 :id? 上换文章时包装组件（router/index.tsx NewNotesRoute）已用 key 换掉整个实例，
    // 所以这里只在挂载时跑一次；保留重置是给「不经包装直接渲染本组件」留的后路。
    useEffect(() => {
        if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
        setEditId(id);
        savedIdRef.current = id;
        createdHereRef.current = false;
        stopAutosaveRef.current = false;
        publishingRef.current = false;
        inFlightRef.current = null;
        queuedRef.current = null;
        seededRef.current = false;
        hydratedRef.current = false;
        retryRef.current = 0;
        setHydrated(false);
        setIsRevision(false);
        setSaveState('idle');
        initNote()
        if (!id) setHydrated(true)
    },[id])

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
                // 编辑器专用接口：公开的 /api/public/notes/:id 会挡掉草稿/私密文章（A4 过滤），
                // 草稿箱点进来必然 404、编辑器打不开自己的草稿。
                // 返回 { note, draft }，有未发布的修改稿就用它回填（它才是最新内容）。
                const res = await getNoteForEdit(id)
                const data = res.data.data
                const row = data.draft ?? data.note
                setIsRevision(!!data.draft)
                form.setFieldsValue({
                    noteTitle: row.noteTitle,
                    noteCategory: row.noteCategory,
                    isTop: row.isTop,
                    // 状态取**原文章**的：修改稿自身恒为 draft，拿它回填会让弹窗默认「草稿」，
                    // 用户不改直接点发布就把已发布文章撤下来了
                    status: data.note.status,
                    description: row.description,
                })
                setAiContent(row.description)
                setTitle(row.noteTitle)
                setNoteContent(row.noteContent)

                // Safe parsing of tags to avoid NaN
                const tagsStr = row.noteTags;
                let parsedTags: number[] = [];
                if (tagsStr && tagsStr.trim() !== '') {
                     parsedTags = tagsStr.split(',')
                        .map((tag: string) => parseInt(tag, 10))
                        .filter((num: number) => !isNaN(num));
                }
                setNoteTag(parsedTags);
                form.setFieldValue('noteTags', parsedTags);

                // Set cover if exists
                if(row.cover) {
                    setCoverImg(row.cover);
                    setCoverCrop(cropFromRow(row) ?? {...DEFAULT_CROP});
                    // 轮播那套：老文章没有独立参数（NULL）→ 回填成卡片那套的值，
                    // 否则一开弹窗「置顶轮播」页签会显示默认居中，与线上实际渲染不符
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
            }catch (error){
                message.error("获取文章信息出错")
                // 故意不置 hydrated：读失败时宁可关掉自动保存，也不能把空内容写进文章
            }
        }
    }


    //回调函数区域

    /**
     * 打开封面裁剪窗。fresh = 换了新图（从默认居中开始，父组件已重置过参数），
     * false = 点「调整裁剪」沿用当前参数。快照用于取消时还原（两套一起）。
     */
    const openCropper = (fresh: boolean) => {
        cropSnap.current = {carousel: coverCropCarousel, card: coverCrop};
        if (fresh) {
            // 换新图：旧图上的焦点对新图没有意义，两套都退回默认居中。
            // 但只有「原来确实存过值」的那套才需要回传这套默认值 —— 否则会把该行固化成
            // 0.5/0.5/1，让轮播从此不再跟随卡片那套（从未设过的应保持 NULL 走回退链）。
            const hadCarousel = !isDefaultCrop(coverCropCarousel);
            const hadCard = !isDefaultCrop(coverCrop);
            setCoverCrop({...DEFAULT_CROP});
            setCoverCropCarousel({...DEFAULT_CROP});
            // 用 or 合并而非覆盖：中途「删掉封面又选回新图」时，删封面那一步已经把两套标脏
            // （旧值看不见了，只能靠标脏保证重新选图后一定覆盖写入）
            setCropDirty(d => ({carousel: d.carousel || hadCarousel, card: d.card || hadCard}));
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
            openCropper(true); // 新图 → 打开裁剪窗，从默认居中开始
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
             setCoverCrop({...DEFAULT_CROP});
             setCoverCropCarousel({...DEFAULT_CROP});
             // 封面被删：库里可能还留着旧图的焦点值（后端无法清空列），标脏以保证
             // 之后再选新图时会把两套参数覆盖写一遍，不残留旧图焦点
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
        openCropper(true); // 新图 → 打开裁剪窗
    };

    const onFinish = async (formValues: any) => {
        // Safe string conversion for tags
        const tagsData = formValues.noteTags;
        const tagsString = Array.isArray(tagsData) ? tagsData.join(',') : (tagsData || '');

        const now = dayjs(new Date()).format('YYYY-MM-DD hh:mm:ss');
        const data = {
            noteTitle: formValues.noteTitle,
            noteContent: noteContent,
            cover: coverImg,
            // 有封面就总是回传数值参数（没调过即默认），保证线上渲染与裁剪预览一致
            coverFocusX: coverImg ? coverCrop.x : null,
            coverFocusY: coverImg ? coverCrop.y : null,
            coverZoom: coverImg ? coverCrop.z : null,
            // 轮播那套只在用户动过时才回传：三列同进同出（后端按原子三元组判定，
            // 只发一列会让整组被渲染端忽略 = 写入静默失效），未动则发 null 保持回退链
            carouselFocusX: coverImg && cropDirty.carousel ? coverCropCarousel.x : null,
            carouselFocusY: coverImg && cropDirty.carousel ? coverCropCarousel.y : null,
            carouselZoom: coverImg && cropDirty.carousel ? coverCropCarousel.z : null,
            description: aiContent,
            noteCategory: formValues.noteCategory,
            noteTags: tagsString,
            isTop: Number(formValues.isTop),
            status: formValues.status,
            updateTime: now
        }

        // 提交目标：自动保存已经替我们把行建好了（新建时首次自动保存返回的 id 会就地采纳），
        // 所以正常路径全是「更新」。只有自动保存一次都没成功（接口故障）时才回退到新建接口。
        let targetId = editId;
        if (!targetId) {
            try {
                const r = await autosaveDraft(buildPayload());
                const newId = r?.data?.data?.id;
                if (newId) {
                    targetId = String(newId);
                    savedIdRef.current = targetId;
                    setEditId(targetId);
                }
            } catch (e) { /* 落到 createNote 兜底 */ }
        }

        // 冻结自动保存，并等在途的那一发回来。两件事缺一不可：
        // 在途请求带着发布前的内容，若落在「发布时删修改稿」之后，会按 draft_of 又克隆出一行
        // 同内容修改稿（草稿箱凭空多一份）；冻结则挡住这 2s 窗口内新排的自动保存。
        publishingRef.current = true;
        if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
        if (inFlightRef.current) { try { await inFlightRef.current; } catch (e) { /* 失败已由重试链兜 */ } }

        const snapBeforePublish = JSON.stringify(buildPayloadRef.current());

        try {
            if (targetId) {
                const res = await updateNote(targetId, data)
                if (res.status === 200) {
                    dispatch<any>(fetchNoteList(true))
                    const stayInEditor = data.status === 'draft';
                    message.success(stayInEditor ? "已保存到草稿箱" : "文章更新成功")
                    setOpen(false); // Close modal
                    if (stayInEditor) {
                        // 留在编辑器接着写：草稿箱里已经有这一行，跳走反而打断写作。
                        // 把「已保存」基准对齐到当前内容，卸载时就不会再白发一次；
                        // 若提交期间内容又变了（弹窗里还能改描述），则不对齐、再排一发把最新全文写回去
                        publishingRef.current = false;
                        if (JSON.stringify(buildPayloadRef.current()) === snapBeforePublish) {
                            lastSavedRef.current = snapBeforePublish;
                        } else {
                            scheduleAutosave();
                        }
                    } else {
                        // 发布完成 → 关掉自动保存：否则卸载时那次补发会给刚发布的文章建出一行
                        // 内容相同的「修改稿」，草稿箱里凭空多一个副本
                        stopAutosaveRef.current = true;
                        if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
                        goBackToList()
                    }
                } else {
                    publishingRef.current = false; // 接口返回非 200：放开自动保存并把内容补写回去
                    scheduleAutosave();
                }
            } else {
                // 兜底：自动保存从未成功过 → 沿用老的新建接口，建完回列表（避免再点一次又建一行）
                const res = await createNote({...data, createTime: now})
                if (res.status === 200) {
                    dispatch<any>(fetchNoteList(true))
                    message.success("文章创建成功")
                    stopAutosaveRef.current = true;
                    if (autosaveTimer.current) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null; }
                    setOpen(false); // Close modal on create success
                    goBackToList()
                } else {
                    publishingRef.current = false;
                    scheduleAutosave();
                }
            }
        } catch (error) {
            publishingRef.current = false;
            scheduleAutosave();
            message.error("文章保存失败：" + error)
        }
    }
    /**
     * 回列表页：**带上列表原来的查询条件**。
     *
     * 列表页每次 URL 变化都会把 query 串写进 sessionStorage（`notes:listReturn`）。直接
     * `navigate('/dashboard/notes')` 会把 tab / 页码 / 搜索条件全丢掉，用户从编辑器回来
     * 又得重翻一遍 —— 就是「翻到一页改完文章配置，页码又回到第一页」的另一半原因
     * （前半是改配置后整表重拉触发的分页钳制，见 AllNotes 的 onOk）。
     *
     * 三级兜底：有票据 → 回那个 URL；没票据但历史里有上一页 → 后退；直接打开编辑器
     * （新标签页 / 书签）→ 回列表首页。
     * 一律 `{replace:true}`：否则再按一次后退又回到刚提交完的编辑器。
     */
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
            <div className="article_title">
                <label style={{width:115,fontSize:18,fontWeight:600}}>文章标题</label>
                <Input style={{background: 'transparent', width: '95%', marginRight: 10}} onChange={handleInputChange} value={noteTitle}/>
                <Button type="primary" onClick={showModal} style={{float: "right"}}>
                    提交
                </Button>
                {/* 自动保存状态：不用弹窗打扰，只在这里显示一行淡淡的字 */}
                <span style={{
                    float: 'right',
                    marginRight: 12,
                    lineHeight: '32px',
                    fontSize: 12,
                    color: saveState === 'error' ? '#ff4d4f' : '#999',
                }}>
                    {saveState === 'saving' ? '草稿保存中…'
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

                <Form {...formItemLayout} variant="filled" style={{ maxWidth: 600 }} form={form} onFinish={onFinish}
                      onValuesChange={() => scheduleAutosave()}>
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
                    </Form.Item>


                    <Form.Item label="文章分类" name="noteCategory" rules={[{ required: true, message: 'Please input!'}]}>
                        <Select>
                            {categories.map((item: { categoryTitle: string | number | boolean; categoryKey: number }) => (
                                <Select.Option value={item.categoryKey}>{item.categoryTitle}</Select.Option>
                            ))}
                        </Select>
                    </Form.Item>

                    {/* 20260919：原来的两级 TreeSelect 只能从既有字典里挑、不能就地新建，
                        还带 required 强制必填（用户反馈"非常难用而且有错误"）。换成扁平多选，
                        下拉底部可就地新建；不再强制必填 —— 标签是可选的元数据。 */}
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

            {/*封面裁剪：两个页签各一套参数；确认写回，取消还原打开前的快照（图片保留）。
               弹窗只上报「这次打开里动过哪套」，与父组件已有的 dirty 合并后决定回传哪些字段*/}
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
