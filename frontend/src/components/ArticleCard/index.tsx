import './index.sass'
import {resolveApiAssetUrl} from '../../utils/runtimeApi'
import {type FC, type ReactNode} from 'react'
import type {NoteType} from '../../interface/NoteType'
import type {CategoriesType} from '../../interface/CategoriesType'
import AssetImage from '../AssetImage'
import SweepLoading from '../SweepLoading'
import NoteByline from '../NoteByline'
import {CommentIcon, EyeIcon, HeartIcon, StarIcon} from '../NoteStatIcons'
import {renderNoteTagsCollapsed} from '../../apis/TagMethods'
import {statCells} from '../../utils/noteStats'
import {CARD_ASPECT, carouselCropOf, coverCropStyle, cropFromRow, type CoverCrop} from '../../utils/coverCrop'

/** Icons correspond to the normalized stat cell keys. */
const STAT_ICON: Record<string, ReactNode> = {
    views: <EyeIcon size={13} />,
    likes: <HeartIcon size={13} />,
    favorites: <StarIcon size={13} />,
    comments: <CommentIcon size={13} />,
}

const NoteStats: FC<{ item: NoteType }> = ({ item }) => {
    const cells = statCells(item)
    return (
        <div className="ArticleStats">
            {cells.map(cell => (
                <span className="ArticleStat" key={cell.key} title={cell.label}>
                    {STAT_ICON[cell.key]}
                    <span className="ArticleStatNum">{cell.value}</span>
                </span>
            ))}
        </div>
    )
}

export interface ArticleCardProps {
    item: NoteType
    categories?: CategoriesType[]
    avatar?: string
    name?: string
    tags?: Parameters<typeof renderNoteTagsCollapsed>[1]
    number?: number
    featured?: boolean
    preview?: boolean
    newTab?: boolean
    imageVisible?: boolean
    crop?: CoverCrop | null
    className?: string
    tabIndex?: number
    expanded?: boolean
    onOpen?: (url: string) => void
}

export default function ArticleCard({item, categories = [], avatar = '', name = '', tags = [], number,
    featured = false, preview = false, newTab = false, imageVisible = true, crop, className = '', tabIndex, expanded = false, onOpen}: ArticleCardProps) {
    const category = categories.find(value => value.categoryKey === Number(item.noteCategory))?.categoryTitle || item.categoryTitle
    const Heading = 'h3'
    const hasTags = (item.noteTagRefs ?? item.noteTags)?.length > 0
    const imageCrop = crop === undefined ? (featured ? carouselCropOf(item) : cropFromRow(item)) : crop
    return <article className={`ArticleCard ${className}`} data-card-kind={featured ? 'featured' : 'article'} data-expanded={expanded}
        onClick={event => {
            if (preview || (event.target as Element).closest('a,button,.tags')) return
            if (window.getSelection()?.toString()) return
            if (newTab) window.open(`/article/${item.key}`, '_blank', 'noopener,noreferrer')
            else if (onOpen) onOpen(`/article/${item.key}`)
            else window.location.assign(`/article/${item.key}`)
        }}>
        <div className="ArticleMedia">
            {number !== undefined && <span className="ArticleNumber">{String(number).padStart(2, '0')}</span>}
            <div className="ArticleCover" style={{aspectRatio: CARD_ASPECT}}>
                {imageVisible && (preview
                    ? <img src={resolveApiAssetUrl(item.cover)} alt="" style={coverCropStyle(imageCrop)}/>
                    : <AssetImage pending={<SweepLoading/>} alt={item.noteTitle} src={item.cover} style={coverCropStyle(imageCrop)}/>)}
            </div>
        </div>
        <div className="ArticleContent">
            <div className="ArticleHead">{category && <span className="ArticleCategory">{category}</span>}</div>
            <Heading className="ArticleTitle">{preview ? item.noteTitle : <a href={`/article/${item.key}`}
                tabIndex={tabIndex} onClick={event => {
                    if (onOpen && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
                        event.preventDefault(); onOpen(`/article/${item.key}`)
                    }
                }} target={newTab ? '_blank' : undefined} rel={newTab ? 'noopener noreferrer' : undefined}>{item.noteTitle}</a>}</Heading>
            <div className="descSlot"><p className="ArticleDescription">{item.description}</p></div>
            <div className="tags">{hasTags && renderNoteTagsCollapsed(item.noteTags, tags, expanded ? 3 : 2, item.noteTagRefs)}</div>
            <NoteStats item={item}/>
            <div className="ArticleFooter"><NoteByline item={item} siteAvatar={avatar} siteName={name} card/></div>
        </div>
    </article>
}
