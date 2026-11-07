import React, {useEffect, useRef, useState} from 'react'
import {Button, Modal, Segmented, Slider, Tabs} from 'antd'
import Cropper, {type Area} from 'react-easy-crop'
import {resolveApiAssetUrl} from '../../utils/runtimeApi'
import {CARD_ASPECT, CAROUSEL_ASPECT, DETAIL_ASPECT, COMPLETE_COVER, DEFAULT_CROP, MAX_ZOOM,
    coverCropStyle, cropWindowInImage, type CoverCrop} from '../../utils/coverCrop'
import './index.sass'

export interface CoverCropResult {
    carousel: CoverCrop
    card: CoverCrop
    dirty: {carousel: boolean; card: boolean}
}
interface Props {
    open: boolean
    src: string
    initialCarousel?: CoverCrop | null
    initialCard?: CoverCrop | null
    onCancel: () => void
    onConfirm: (result: CoverCropResult) => void
}

function CropStage({src, aspect, value, onChange, natural}: {
    src: string; aspect: number; value: CoverCrop; onChange: (value: CoverCrop) => void
    natural: {width: number; height: number}
}) {
    const [position, setPosition] = useState({x: 0, y: 0})
    const [zoom, setZoom] = useState(value.z)
    const interacting = useRef(false)
    const initial = useRef(value)
    const win = cropWindowInImage(natural.width, natural.height, aspect, initial.current)
    const area: Area = {
        x: win.x / natural.width * 100, y: win.y / natural.height * 100,
        width: win.w / natural.width * 100, height: win.h / natural.height * 100,
    }
    return <>
        <div className="ccStage" style={{aspectRatio: aspect}}>
            <Cropper image={src} crop={position} zoom={zoom} aspect={aspect}
                objectFit="cover" maxZoom={MAX_ZOOM} onCropChange={setPosition}
                onZoomChange={setZoom} initialCroppedAreaPercentages={area}
                onInteractionStart={() => {interacting.current = true}}
                onCropAreaChange={next => {
                    if (!interacting.current) return
                    onChange({x: next.width < 99.999 ? next.x / (100 - next.width) : 0.5,
                        y: next.height < 99.999 ? next.y / (100 - next.height) : 0.5,
                        z: zoom, fit: 'cover'})
                }}/>
        </div>
        <div className="ccHint">拖动调整主体位置，滚轮或滑块缩放</div>
        <Slider aria-label="封面缩放" min={1} max={MAX_ZOOM} step={0.01} value={zoom}
            onChange={next => {interacting.current = true; setZoom(next)}}/>
    </>
}

const Preview = ({src, value, aspect, label}: {
    src: string; value: CoverCrop; aspect: number; label: string
}) => <div className="ccPreviewItem">
    <div className="ccPreviewLabel">{label}</div>
    <div className="ccPreviewFrame" style={{aspectRatio: aspect}}>
        <img alt={label} src={src} style={{width: '100%', height: '100%', objectFit: 'cover',
            display: 'block', ...coverCropStyle(value)}}/>
    </div>
</div>

const CoverCropModal: React.FC<Props> = ({open, src, initialCarousel, initialCard,
    onCancel, onConfirm}) => {
    const [tab, setTab] = useState<'carousel' | 'card'>('card')
    const [card, setCard] = useState<CoverCrop>(DEFAULT_CROP)
    const [carousel, setCarousel] = useState<CoverCrop>(DEFAULT_CROP)
    const [dirty, setDirty] = useState({card: false, carousel: false})
    const [revision, setRevision] = useState(0)
    const [natural, setNatural] = useState<{width: number; height: number} | null>(null)
    const [failed, setFailed] = useState(false)
    const initial = useRef({card: initialCard, carousel: initialCarousel})
    initial.current = {card: initialCard, carousel: initialCarousel}
    useEffect(() => {
        if (!open) return
        setCard({...initial.current.card ?? DEFAULT_CROP})
        setCarousel({...initial.current.carousel ?? DEFAULT_CROP})
        setDirty({card: false, carousel: false})
        setTab('card')
        setRevision(n => n + 1)
        setNatural(null)
        setFailed(false)
        let active = true
        // 只读取尺寸，不读画布像素；原生元素避开组件脚本对 window.Image 的 CORS 包装。
        const image = document.createElement('img')
        image.onload = () => {
            if (active && image.naturalWidth > 0 && image.naturalHeight > 0)
                setNatural({width: image.naturalWidth, height: image.naturalHeight})
            else if (active) setFailed(true)
        }
        image.onerror = () => {if (active) setFailed(true)}
        image.src = resolveApiAssetUrl(src)
        return () => {active = false}
    }, [open, src])
    const source = resolveApiAssetUrl(src)
    const update = (key: 'carousel' | 'card', value: CoverCrop) => {
        if (key === 'card') setCard(value)
        else setCarousel(value)
        setDirty(prev => ({...prev, [key]: true}))
    }
    const pane = (key: 'carousel' | 'card', value: CoverCrop, aspect: number) => <>
        <Segmented aria-label="封面显示方式" value={value.fit ?? 'cover'} options={[
            {label: '完整显示（允许留边）', value: 'contain'},
            {label: '铺满裁切', value: 'cover'},
        ]} onChange={fit => {update(key, {...DEFAULT_CROP, fit: fit as 'cover' | 'contain'})
            setRevision(n => n + 1)}}/>
        <div className="ccBody">
            <div className="ccEditor">
                {value.fit === 'contain'
                    ? <Preview src={source} value={value} aspect={aspect} label="完整图片，不裁切"/>
                    : natural && <CropStage key={`${src}-${key}-${revision}`} src={source} aspect={aspect}
                        value={value} natural={natural} onChange={next => update(key, next)}/>}
            </div>
            <div className="ccPreviews">
                <Preview src={source} value={value} aspect={aspect}
                    label={key === 'card' ? '文章卡片' : '首页轮播'}/>
                {key === 'card' && <Preview src={source} value={value} aspect={DETAIL_ASPECT} label="详情横幅"/>}
            </div>
        </div>
    </>
    return <Modal open={open} onCancel={onCancel} title="封面显示方式" width={760}
        centered destroyOnHidden transitionName="" className="CoverCropModal" footer={[
            <Button key="reset" onClick={() => {update(tab, {...COMPLETE_COVER})
                setRevision(n => n + 1)}}>完整显示</Button>,
            <Button key="cancel" onClick={onCancel}>取消</Button>,
            <Button key="ok" type="primary" disabled={!natural}
                onClick={() => onConfirm({card, carousel, dirty})}>确定</Button>,
        ]}>
        {!natural && <p role="status">{failed ? '图片加载失败，请重新选择' : '正在加载图片…'}</p>}
        <Tabs activeKey={tab} onChange={key => setTab(key as typeof tab)} items={[
            {key: 'card', label: '文章卡片 / 详情页', children: pane('card', card, CARD_ASPECT)},
            {key: 'carousel', label: '首页置顶轮播', children: pane('carousel', carousel, CAROUSEL_ASPECT)},
        ]}/>
        <p className="ccNote">保留原图片。竖图、海报和带文字的图片建议完整显示；照片可裁切突出主体。</p>
    </Modal>
}
export default CoverCropModal
