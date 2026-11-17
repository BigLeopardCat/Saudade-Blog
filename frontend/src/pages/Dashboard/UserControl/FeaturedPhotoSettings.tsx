import {useEffect, useState} from 'react'
import {Alert, Button, Input, message, Modal, Spin} from 'antd'
import http from '../../../apis/axios'
import {FEATURED_PHOTO_LIMIT, type PhotoSelection} from '../../../apis/featuredPhotos'
import {useGalleryPager} from '../../../utils/galleryPager'
import {resolveApiAssetUrl} from '../../../utils/runtimeApi'
import './featured-photos.css'

export default function FeaturedPhotoSettings() {
    const [items, setItems] = useState<PhotoSelection[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [saving, setSaving] = useState(false)
    const [picker, setPicker] = useState(false)
    const [revision, setRevision] = useState(0)
    const gallery = useGalleryPager(picker)
    useEffect(() => {
        const controller = new AbortController()
        setLoading(true); setError('')
        http.get('/api/protected/websetting', {signal: controller.signal}).then(({data}) => {
            if (data.code !== 200) throw new Error(data.message || '读取设置失败')
            setItems(data.data.featuredPhotos ?? [])
        }).catch(error => { if (!controller.signal.aborted) setError(error.message || '读取设置失败') })
            .finally(() => { if (!controller.signal.aborted) setLoading(false) })
        return () => controller.abort()
    }, [revision])
    const save = async () => {
        setSaving(true)
        try {
            const {data} = await http.post('/api/protected/websetting', {featuredPhotos: items})
            if (data.code !== 200) throw new Error(data.message || '保存失败')
            message.success('精选相册已保存')
        } catch (error) { message.error(error instanceof Error ? error.message : '保存失败，请重试') }
        finally { setSaving(false) }
    }
    const reorder = (index: number, step: number) => setItems(previous => {
        const next = [...previous]; [next[index], next[index + step]] = [next[index + step], next[index]]; return next
    })
    if (loading) return <Spin aria-label="读取相册设置"/>
    if (error) return <Alert type="error" message={error} action={<Button onClick={() => setRevision(value => value + 1)}>重试</Button>}/>
    return <section className="featuredPhotoSettings" aria-label="相册精选设置">
        <p>从图库选取最多 {FEATURED_PHOTO_LIMIT} 张公开照片，按下面的顺序展示。首页点击相纸后才加载当前照片。</p>
        <fieldset disabled={saving}>
            <ol className="selectedPhotos">
                {items.map((item, index) => <li key={item.imageId}>
                    <span className="selectedPhotoId">#{item.imageId}</span>
                    <Input aria-label={`照片 ${item.imageId} 的说明`} value={item.caption} maxLength={120} placeholder="照片说明" disabled={saving} onChange={event => setItems(previous => previous.map(photo => photo.imageId === item.imageId ? {...photo, caption: event.target.value} : photo))}/>
                    <Button aria-label={`照片 ${item.imageId} 前移`} disabled={saving || index === 0} onClick={() => reorder(index, -1)}>↑</Button>
                    <Button aria-label={`照片 ${item.imageId} 后移`} disabled={saving || index === items.length - 1} onClick={() => reorder(index, 1)}>↓</Button>
                    <Button danger disabled={saving} onClick={() => setItems(previous => previous.filter(photo => photo.imageId !== item.imageId))}>移除</Button>
                </li>)}
            </ol>
            <div className="photoSettingsActions"><Button disabled={saving || items.length >= FEATURED_PHOTO_LIMIT} onClick={() => setPicker(true)}>从图库选择</Button><Button type="primary" loading={saving} onClick={save}>保存精选相册</Button></div>
        </fieldset>
        <Modal title="选择精选照片" open={picker} onCancel={() => setPicker(false)} footer={<Button onClick={() => setPicker(false)}>完成选择</Button>} width={760} destroyOnHidden>
            <p>所选图片会公开展示；移除所有照片并保存可关闭首页相册。</p>
            {picker && <>
                {gallery.loading && <Spin/>}
                {gallery.error && <Alert type="error" message={gallery.error} action={<Button onClick={() => gallery.reload()}>重试</Button>}/>}
                <div className="featuredPhotoChoices">{gallery.images.map(image => {
                    const selected = items.some(item => item.imageId === image.imageKey)
                    const name = image.displayName || `图片 ${image.imageKey}`
                    return <button type="button" key={image.imageKey} aria-label={`选择 ${name}`} aria-pressed={selected} disabled={!selected && items.length >= FEATURED_PHOTO_LIMIT} onClick={() => setItems(previous => selected ? previous.filter(item => item.imageId !== image.imageKey) : [...previous, {imageId: image.imageKey, caption: image.displayName || ''}])}>
                        <img src={resolveApiAssetUrl(image.imageUrl)} alt="" loading="lazy" decoding="async"/><span>{name}</span>{selected && <b aria-hidden="true">✓</b>}
                    </button>
                })}</div>
                {gallery.pageError && <Alert type="error" message={gallery.pageError}/>}
                {gallery.hasMore && <Button loading={gallery.loadingMore} onClick={() => gallery.loadMore()}>加载更多</Button>}
            </>}
        </Modal>
    </section>
}
