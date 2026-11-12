import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import gfm from '@bytemd/plugin-gfm'
import math from "@bytemd/plugin-math";
import 'katex/dist/katex.css';
import breaks from "@bytemd/plugin-breaks";
import frontmatter from "@bytemd/plugin-frontmatter";
import gemoji from "@bytemd/plugin-gemoji";
import highlight from "@bytemd/plugin-highlight";
import { Editor } from '@bytemd/react'
import type { BytemdEditorContext, BytemdPlugin } from 'bytemd'
import mediumZoom from '@bytemd/plugin-medium-zoom'
import 'bytemd/dist/index.css'
import zhCN from 'bytemd/locales/zh_Hans.json'
import 'github-markdown-css/github-markdown-light.css'
import './index.css'
import http from "../../apis/axios.tsx";
import { message } from "antd";
import { bytemdStickers } from "../../utils/stickers";
import ImagePicker from './ImagePicker.tsx'
import type { UploadedImage } from './ImagePicker.tsx'
import { encodeAssetUrl } from '../../utils/assetUrl'

const basePlugins = [
    gfm({ singleTilde: false }),
    math(),
    breaks(),
    frontmatter(),
    gemoji(),
    highlight(),
    mediumZoom(),
    bytemdStickers
]

/** Bytemd 左工具栏图片按钮的下标；选择器限定 .bytemd-toolbar-left，避免命中右工具栏。 */
const BUILTIN_IMAGE_ACTION = '.bytemd-toolbar-left > .bytemd-toolbar-icon[bytemd-tippy-path="5"]'

/** 发一次上传请求。失败一律**抛**（调用方按"没拿到图片"处理）。 */
async function postUpload(file: File) {
    const formData = new FormData();
    formData.append('file', file);
    try {
        return await http({
            url: '/api/protect/upload',
            method: 'POST',
            data: formData
        });
    } catch (error) {
        console.error('Error during image upload:', error);
        message.error('上传失败：网络错误');
        throw error;
    }
}

interface Editor_Props {
    setNoteContent: (content: string) => void,
    noteContent: string,
    editorRef?: Ref<EditorHandle>
}

export interface EditorHandle {
    read: () => string;
    apply: (content: string) => void;
}

const Editor_ = ({ setNoteContent, noteContent, editorRef }: Editor_Props) => {

    const wrapRef = useRef<HTMLDivElement | null>(null)
    /** bytemd 的编辑器上下文（插件钩子给的，见 ctxPlugin）——插入正文要用它。 */
    const ctxRef = useRef<BytemdEditorContext | null>(null)
    const [pickerOpen, setPickerOpen] = useState(false)
    useImperativeHandle(editorRef, () => ({
        read: () => ctxRef.current?.editor.getValue() ?? noteContent,
        apply: content => {
            const editor = ctxRef.current?.editor
            if (!editor) throw new Error('编辑器尚未就绪')
            const selections = editor.listSelections()
            const scroll = editor.getScrollInfo()
            editor.operation(() => {
                editor.replaceRange(content, {line: 0, ch: 0},
                    {line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length}, 'agent-proposal')
                editor.setSelections(selections)
            })
            editor.scrollTo(scroll.left, scroll.top)
            setNoteContent(content)
        },
    }), [noteContent, setNoteContent])

    /** 通过 Bytemd editorEffect 保留编辑器上下文，供图库插图使用。 */
    const ctxPlugin = useMemo<BytemdPlugin>(() => ({
        editorEffect: (ctx) => {
            ctxRef.current = ctx
            return () => { ctxRef.current = null }
        }
    }), [])

    // 数组身份必须稳定：bytemd 里 `$: if (editor && plugins)` 一变就 `off()` + `on()`
    // 重建键盘映射（`svelte/editor.svelte`），每次渲染换个新数组等于每敲一个字重来一遍。
    const plugins = useMemo<BytemdPlugin[]>(() => [...basePlugins, ctxPlugin], [ctxPlugin])

    const handleImageUpload = async (files: File[]): Promise<UploadedImage[]> => {
        const response = await postUpload(files[0]);
        if (response.data?.code !== 200) {
            message.error(response.data?.message || '上传失败');
            // **抛**而不是 `return []`：bytemd 会对返回值 `map/join` 后 `appendBlock`
            // （`svelte/editor.js::handleImageUpload`），空数组会往正文里插一个空行、
            // 还按 `imgs.length * 2 - 2` 算出负的行号。
            throw new Error(response.data?.message || 'upload failed');
        }
        message.success('添加成功');
        // 上传 URL 先编码，再交由 Bytemd 插入 Markdown；与图库插图共用幂等编码。
        return [{ alt: '', url: encodeAssetUrl(response.data.data), title: '' }];
    };

    useEffect(() => {
        const wrap = wrapRef.current
        if (!wrap) return
        const onClickCapture = (e: MouseEvent) => {
            const target = e.target as Element | null
            if (!target?.closest?.(BUILTIN_IMAGE_ACTION)) return
            e.stopPropagation()
            setPickerOpen(true)
        }
        wrap.addEventListener('click', onClickCapture, true)
        return () => wrap.removeEventListener('click', onClickCapture, true)
    }, [])

    /** 通过 Bytemd appendBlock 插入编码后的图片 Markdown，并将焦点交回编辑器。 */
    const insertImage = (url: string) => {
        const ctx = ctxRef.current
        if (!ctx) {
            message.error('编辑器还没准备好，请稍后再试')
            return
        }
        const pos = ctx.appendBlock(`![](${encodeAssetUrl(url)})`)
        ctx.editor.setSelection(pos, ctx.codemirror.Pos(pos.line))
        ctx.editor.focus()
    }

    const pickImage = (url: string) => {
        insertImage(url)
        setPickerOpen(false)
        message.success('已插入图片')
    }

    return (
        <div className='saudade-note-editor' ref={wrapRef}>
            <Editor
                value={noteContent}
                plugins={plugins}
                locale={zhCN}
                onChange={(v) => {
                    setNoteContent(v)
                }}
                uploadImages={(e) => handleImageUpload(e)}
            />
            <ImagePicker
                open={pickerOpen}
                onCancel={() => setPickerOpen(false)}
                onPick={pickImage}
                upload={handleImageUpload}
            />
        </div>
    )
}

export default Editor_
