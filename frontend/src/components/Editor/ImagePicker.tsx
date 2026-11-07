import { useEffect, useState } from 'react'
import { Alert, Button, Card, Col, Empty, Modal, Row, Spin, Tabs, Upload, message } from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import type { EditorProps } from '@bytemd/react'
import { useGalleryPager } from '../../utils/galleryPager.ts'
import { assetDisplayName } from '../../utils/assetName'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'


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
    const [uploading, setUploading] = useState(false)
    const { images, loading, loadingMore, error, pageError, hasMore, reload, loadMore } = useGalleryPager(open)

    useEffect(() => {if (open) setTab('gallery')}, [open])

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
            ) : error ? (
                <Alert type="error" showIcon message={error} action={<Button onClick={()=>void reload()}>重试</Button>}/>
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
                                            alt={img.displayName||assetDisplayName(img.imageUrl)}
                                            // 缩略图懒加载：图库可能有几十上百张，而本地盘的
                                            // `/api/protect/download/` 走的就是这台机器 3M 的上行
                                            loading="lazy"
                                            src={resolveApiAssetUrl(img.imageUrl)}
                                            style={{ height: 100, objectFit: 'cover' }}
                                        />
                                    }
                                    onClick={() => onPick(img.imageUrl)}
                                >
                                    <div className="editor-gallery-name">{img.displayName||assetDisplayName(img.imageUrl)}</div>
                                </Card>
                            </Col>
                        ))}
                    </Row>
                    {pageError&&<Alert type="error" showIcon message={pageError} action={<Button onClick={()=>void reload()}>重试</Button>}/>}
                    {hasMore && (
                        <div className="editor-image-picker-more">
                            <Button
                                type="link"
                                loading={loadingMore}
                                onClick={() => { void loadMore() }}
                            >
                                载入更多
                            </Button>
                        </div>
                    )}
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
