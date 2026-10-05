import { useEffect, useState } from 'react'
import { Alert, Card, Col, Empty, Modal, Row, Spin, Tabs, Upload, message } from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import type { EditorProps } from '@bytemd/react'
import { getImageList } from '../../apis/ImageMethods.tsx'
import { ImgUrl } from '../../interface/ImgTypes'
import { assetDisplayName } from '../../utils/assetName'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'

/**
 * 编辑器工具栏那颗图片按钮点开的东西（20261006 用户要求）：
 * **优先展示服务器上的图库**（`GET /api/protect/images`），本地上传留在第二个页签。
 *
 * ## 为什么这颗按钮是"拦点击"换来的
 *
 * 那颗按钮是 bytemd 的**内置 action**（`getBuiltinActions` 里 `leftActions` 的第 6 项），
 * 点下去直接开系统文件选择框。bytemd 的工具栏没有定制口子：插件的 action 只能
 * `leftActions.push(...)` 追加到末尾，**不能插位、不能覆盖、不能删**；而不传 `uploadImages`
 * 虽然能让那颗图标消失（工具栏只渲染 `{#if item.handler}`），同一个 prop 还闸着拖拽与粘贴
 * 上传。所以那颗按钮原样留着，改由 `Editor_` 在捕获阶段拦下它的点击、开这个弹窗 ——
 * 工具栏的 DOM 与几何一行不动。详见 `./index.tsx`。
 *
 * ## 两件容易写错的事
 *
 * - **写进正文的是库里那个原始串**（本地是 `/api/protect/download/…`、R2 是绝对地址），
 *   `resolveApiAssetUrl` 只用于这里的缩略图 `src`。把 CDN 化后的地址写进正文，
 *   换公开域名时就再也认不出这张图属于哪个桶了（`src/routes/upload.rs` 的删除判据）。
 * - **上传不压缩**：bytemd 自己的拖拽/粘贴路径就是原图直传，压缩会让同一张图产生
 *   两份字节 ⇒ 撞掉"同字节复用"那条判据。这里走的是**同一个** `upload` 回调。
 */

/** bytemd `uploadImages` 的返回元素（mdast 的 Image；**不是** DOM 的 Image）。 */
export type UploadedImage = Awaited<ReturnType<NonNullable<EditorProps['uploadImages']>>>[number]

interface ImagePickerProps {
    open: boolean;
    onCancel: () => void;
    /** 选中 / 上传成功。参数是库里那个原始地址，调用方**原样**写进 markdown。 */
    onPick: (imageUrl: string) => void;
    /** 与 bytemd 拖拽、粘贴走的是同一个上传函数（失败时会抛，且自己已经提示过原因）。 */
    upload: (files: File[]) => Promise<UploadedImage[]>;
}

const ImagePicker = ({ open, onCancel, onPick, upload }: ImagePickerProps) => {
    const [tab, setTab] = useState('gallery')
    const [images, setImages] = useState<ImgUrl[]>([])
    const [loading, setLoading] = useState(false)
    const [loadError, setLoadError] = useState('')
    const [uploading, setUploading] = useState(false)

    // 每次打开都回到「图库」页签并重拉一次列表：图库是主入口，别让上一次的选择粘住，
    // 也别用上次那份可能已经过时的列表（别人刚传的图应该看得见）。
    useEffect(() => {
        if (!open) return
        setTab('gallery')
        setLoading(true)
        setLoadError('')
        // `alive` 防的是"关掉又立刻打开"时前一次请求的迟到回包把新一次的列表覆盖掉
        let alive = true
        getImageList()
            .then((res) => {
                if (!alive) return
                if (res.data?.code !== 200) {
                    setImages([])
                    setLoadError(res.data?.message || '图库读取失败')
                    return
                }
                setImages(Array.isArray(res.data?.data) ? res.data.data : [])
            })
            .catch(() => {
                if (!alive) return
                setImages([])
                setLoadError('图库读取失败')
            })
            .finally(() => {
                if (alive) setLoading(false)
            })
        return () => { alive = false }
    }, [open])

    const localUpload = async (file: File) => {
        setUploading(true)
        try {
            const imgs = await upload([file])
            const url = imgs?.[0]?.url
            if (!url) {
                message.error('上传失败')
                return
            }
            onPick(url)
        } catch {
            // 上传函数自己已经把原因（服务端原话 / 网络错误）提示过了，这里不重复报。
            // 弹窗**不关**、正文**不插** —— 失败就该什么都没发生。
        } finally {
            setUploading(false)
        }
    }

    const gallery = (
        <div className="editor-image-picker">
            {loading ? (
                <div className="editor-image-picker-center"><Spin /></div>
            ) : loadError ? (
                <Alert type="error" showIcon message={loadError} />
            ) : images.length === 0 ? (
                <Empty description="图库里还没有图片，可以用「本地上传」传一张" />
            ) : (
                <div className="editor-image-picker-scroll">
                    <Row gutter={[12, 12]}>
                        {images.map((img) => (
                            <Col span={6} key={img.imageKey}>
                                <Card
                                    hoverable
                                    size="small"
                                    styles={{ body: { padding: '6px 8px' } }}
                                    cover={
                                        <img
                                            className="editor-gallery-item"
                                            alt={assetDisplayName(img.imageUrl)}
                                            // 缩略图懒加载：图库可能有几十上百张，而本地盘的
                                            // `/api/protect/download/` 走的就是这台机器 3M 的上行
                                            loading="lazy"
                                            src={resolveApiAssetUrl(img.imageUrl)}
                                            style={{ height: 100, objectFit: 'cover' }}
                                        />
                                    }
                                    onClick={() => onPick(img.imageUrl)}
                                >
                                    <div className="editor-gallery-name">{assetDisplayName(img.imageUrl)}</div>
                                </Card>
                            </Col>
                        ))}
                    </Row>
                </div>
            )}
        </div>
    )

    const local = (
        <Upload.Dragger
            className="editor-image-picker-upload"
            accept="image/*"
            multiple={false}
            showUploadList={false}
            disabled={uploading}
            // antd 的 `req.file` 声明成 `string | RcFile`（RcFile 继承 File），这里要的是文件对象
            customRequest={(req) => { void localUpload(req.file as File) }}
        >
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p className="ant-upload-text">把图片拖到这里，或点击选择</p>
            <p className="ant-upload-hint">原图直传（不压缩），上传成功会插到正文光标处</p>
        </Upload.Dragger>
    )

    return (
        <Modal
            className="editor-image-picker-modal"
            title="插入图片"
            open={open}
            onCancel={onCancel}
            footer={null}
            width={800}
        >
            <Tabs
                activeKey={tab}
                onChange={setTab}
                items={[
                    { key: 'gallery', label: '图库', children: gallery },
                    { key: 'local', label: '本地上传', children: local },
                ]}
            />
        </Modal>
    )
}

export default ImagePicker
