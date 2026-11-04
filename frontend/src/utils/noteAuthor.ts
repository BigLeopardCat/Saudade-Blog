import type {NoteType} from "../interface/NoteType";

export interface SiteAuthor {
    /** 站点级署名（redux `state.user.name`），没有作者记录的老文章署名就是它 */
    name?: string | null
    /** 站点级头像（redux `state.user.avatar`）——同上 */
    avatar?: string | null
}

export interface NoteAuthor {
    name: string
    avatar: string
}

/** 抹空白：`undefined`/`null` 给空串，两端空白去掉（空值本身**不**改成"没记录"，见契约）。 */
const given = (v: string | null | undefined): string => (v ?? "").trim()

/**
 * 这篇文章该显示谁：**接口给了作者键就照它显示（空头像画默认头像），键整个缺席
 * （老文章 / 发布者已销号 / 这一路接口没挂作者）才回退站点级**。
 * 传入 `item` 可以是任意一张文章行（`NoteType` 或接口原始行都行）。
 */
export function noteAuthor(
    item: Partial<NoteType> | null | undefined,
    site: SiteAuthor,
): NoteAuthor {
    const hasRecord = item?.authorName != null || item?.authorAvatar != null
    if (!hasRecord) {
        return { name: given(site?.name), avatar: given(site?.avatar) }
    }
    // 键在场 ⇒ 后端为这篇文章定过稿：空名字/空头像照原样返回，不再拿站点级去找补
    return { name: given(item?.authorName), avatar: given(item?.authorAvatar) }
}
