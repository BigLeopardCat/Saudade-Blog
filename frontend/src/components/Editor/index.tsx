import { useEffect, useMemo, useRef, useState } from 'react'
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
import 'github-markdown-css/github-markdown-dark.css'
import './index.css'
import http from "../../apis/axios.tsx";
import { message } from "antd";
import { bytemdStickers } from "../../utils/stickers";
import ImagePicker from './ImagePicker.tsx'
import type { UploadedImage } from './ImagePicker.tsx'

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

/**
 * 内置图片按钮在**左组**里的下标。
 *
 * `getBuiltinActions` 的 `leftActions` 是写死的：0 = H 下拉、1 粗体、2 斜体、3 引用、
 * 4 链接、**5 = 图片**（`icons.Pic` + `locale.image`）、6 行内代码、7 代码块、8 无序、9 有序。
 * 这个 `5` 不是随手数出来的：`frontend/tests/editor-image-button.test.mjs` 会去读 bytemd
 * 的源码把它钉住，上游一改次序那条套件立刻红。
 *
 * ⚠️ 选择器**必须**带 `.bytemd-toolbar-left` 前缀：右组（toc/帮助/全屏/源码）里的图标
 * 用的是**右组数组**的下标，那里的 `5` 是「源码」那颗按钮。
 */
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
    noteContent: string
}

const Editor_ = ({ setNoteContent, noteContent }: Editor_Props) => {

    const wrapRef = useRef<HTMLDivElement | null>(null)
    /** bytemd 的编辑器上下文（插件钩子给的，见 ctxPlugin）——插入正文要用它。 */
    const ctxRef = useRef<BytemdEditorContext | null>(null)
    const [pickerOpen, setPickerOpen] = useState(false)

    /**
     * 把 bytemd 的编辑器上下文留下来给图库弹窗用。
     *
     * bytemd 只把上下文交给**插件**（`editorEffect`）和**插件 action 的 handler**，而图片
     * 那颗是内置 action（我们没有 handler 可写），所以只能从这里拿。
     */
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
        // ⚠️ 判**业务码**而不是 `response.status`（20261006 修）：本仓的失败一律是
        // HTTP 200 + `code: 500`，原先那句 `status === 200` 恒真 —— 配额拒绝 / R2 凭据缺失
        // 全都会被显示成「添加成功」，还把 `![]()` 插进正文（失败时 `data` 是空串）。
        if (response.data?.code !== 200) {
            message.error(response.data?.message || '上传失败');
            // **抛**而不是 `return []`：bytemd 会对返回值 `map/join` 后 `appendBlock`
            // （`svelte/editor.js::handleImageUpload`），空数组会往正文里插一个空行、
            // 还按 `imgs.length * 2 - 2` 算出负的行号。
            throw new Error(response.data?.message || 'upload failed');
        }
        message.success('添加成功');
        return [{ alt: '', url: response.data.data, title: '' }];
    };

    /**
     * 拦下内置图片按钮的点击（20261006 用户要求：那颗按钮改为优先展示图库）。
     *
     * 不换按钮、不藏按钮：工具栏的 DOM 与几何一行不动，改在**捕获阶段**把事件掐掉，
     * 让 `.bytemd-toolbar` 上 svelte 的那个 `on:click`（内置 handler = 弹系统文件选择框）
     * 根本收不到 —— 换成开我们自己的图库弹窗。
     */
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

    /**
     * 往正文里插图，**照抄 bytemd 自己的单张路径**（`svelte/editor.js::handleImageUpload`）：
     * `appendBlock` 从光标往下找第一处空行插入 `![](url)`，再把光标落回那一行、聚焦。
     * alt 故意留空 —— 与拖拽/粘贴上传产出的 markdown **逐字节一样**。
     */
    const insertImage = (url: string) => {
        const ctx = ctxRef.current
        if (!ctx) {
            message.error('编辑器还没准备好，请稍后再试')
            return
        }
        const pos = ctx.appendBlock(`![](${url})`)
        ctx.editor.setSelection(pos, ctx.codemirror.Pos(pos.line))
        ctx.editor.focus()
    }

    const pickImage = (url: string) => {
        insertImage(url)
        setPickerOpen(false)
        message.success('已插入图片')
    }

    return (
        // 这里原本是 `className='markdown-body"'`（多一个引号 ⇒ 这个 class 谁也没匹配上，
        // 而本文件里 `.markdown-body` 那几条规则真正的作用对象是 bytemd 预览区的内层 div）。
        // 换成一个真名字，行为不变，顺带给测试一个抓手。
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
