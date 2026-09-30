import { Avatar } from "antd";
import dayjs from "dayjs";
import type { NoteType } from "../../interface/NoteType";
import { noteAuthor } from "../../utils/noteAuthor";

/**
 * 文章卡片页脚的那一组「头像 + 署名 + 发布于/更新于」（20261001）。
 *
 * ## 为什么抽成组件
 *
 * 这段标记在改造前**逐字存在两份**：首页文章卡片（`ContentHome/Article.tsx`）与首页
 * 置顶轮播（`ContentHome/index.tsx` 的 `topFooter`）——两处都是「头像 + 名字 + 两个日期」，
 * 连行内样式里的 5 个空格缩进都一样，只是外层容器的 class 不同（`.ArticleFooter` /
 * `.topFooter`）。所以**外层容器留给调用方**（各自有各自的 padding/margin 与 sass 规则），
 * 本组件只渲染容器**里面**那三样，返回 Fragment ⇒ 不产生额外 DOM 节点，两份卡片的
 * 盒模型与改造前一个像素不差。
 *
 * 抽出来的真正理由是**署名判据**：改造前两处各自拿着 redux 里的站点级 `name`/`avatar`
 * 直接渲染，于是"管理员发的文章也印着超级管理员"这个 bug 要在两个地方各修一遍。
 * 现在判据只此一处（`utils/noteAuthor.ts`），这个组件是它唯一的渲染点。
 *
 * ## 为什么会给 `site*` 传参而不是在组件里 `useSelector`
 *
 * 调用方（`ContentHome`）已经订阅了 redux 的 `state.user`，再订阅一次是同一个值的两个
 * 订阅点；显式传参也让"站点级只是兜底"这件事在调用处一眼可见——两个 prop 名里都带
 * `site` 前缀，读代码的人不会误以为它们是这篇文章的作者。
 */
interface NoteBylineProps {
    item: NoteType
    /** 站点级署名（redux `state.user.name`）——只在文章没有作者记录时用 */
    siteName?: string | null
    /** 站点级头像（redux `state.user.avatar`）——同上 */
    siteAvatar?: string | null
}

const NoteByline = ({ item, siteName, siteAvatar }: NoteBylineProps) => {
    const who = noteAuthor(item, { name: siteName, avatar: siteAvatar });

    return (
        <>
            <Avatar src={who.avatar} size={40} style={{ marginRight: 10 }} />
            <span style={{ fontWeight: 'bold', marginRight: 10, lineHeight: '22px', fontSize: '14px' }}>{who.name}</span>
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 12, color: '#7f7e7e', lineHeight: '22px' }} className='post-date'>
                    <i className="iconfont icon-naozhong icon" style={{ fontSize: 14, display: 'inline', marginRight: '4px' }}></i>
                    发布于 {dayjs(item.createTime).format('YYYY-MM-DD')}
                </span>
                <span style={{ position: 'absolute', top: '100%', marginTop: '6px', left: 0, fontSize: 12, color: '#7f7e7e', lineHeight: '22px', whiteSpace: 'nowrap' }} className='post-date'>
                    <i className="iconfont icon-naozhong icon" style={{ fontSize: 14, display: 'inline', marginRight: '4px' }}></i>
                    更新于 {dayjs(item.updateTime).format('YYYY-MM-DD')}
                </span>
            </div>
        </>
    )
}

export default NoteByline;
