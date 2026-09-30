import type {NoteType} from "../interface/NoteType";

/**
 * 文章卡片上"这张脸和这个名字是谁"的**唯一判据**（20261001）。
 *
 * 病症（用户原话）：「文章发布的卡片没有作者信息，管理员发的文章还是超级管理员的头像和
 * 署名在文章卡片上。」——改造前卡片上的人名/头像**与文章无关**：它取的是站点级那一份
 * （`GET /api/public/user` ⇒ redux `state.user`，见 `store/components/user.tsx`），
 * 全站每一张卡片印的都是站点主人。后端 20261001 起在 `note.user_id` 记下了发布者，
 * 列表/详情接口多回两个可选键 `authorName`/`authorAvatar`（见 `interface/NoteType.d.ts`
 * 里那段与 `src/routes/notes.rs::attach_authors`）。本文件就是"拿到那两个键以后该显示谁"。
 *
 * 为什么抽成纯函数而不是在四个地方各写一遍 `||`：
 *   · **有四个消费方**——首页卡片（`ContentHome/Article.tsx`）、首页置顶轮播
 *     （`ContentHome/index.tsx` 的 `topFooter`）、分类页列表（`Categories/index.tsx`）、
 *     文章详情页横幅（`ReadArticle/index.tsx`）。任一处的 `||` 写反（比如把站点级写在前面）
 *     就只有那一个页面症状不对，另外三处看着正常，排查时极易漏。
 *   · 回退规则本身是**契约**，与后端 `attach_authors` 的回退链逐字对应：后端已经保证
 *     "有作者记录 ⇒ 两个键都回、且非空"，所以前端这一层的职责只有一条——**键缺席时**兜底。
 *     两边都兜底不是重复，是让"接口少回一个键"（老缓存 / 别的列表接口没挂作者）不至于
 *     把卡片变空白。
 *
 * 契约（与 `statCells` 同源的"读不到 ≠ 编一个"取向）：
 *   · `authorName` / `authorAvatar` 各自独立判断——只填了名字没填头像（发布者没上传过头像）
 *     时，名字用文章的、头像回退站点级，不会因为一个字段连累另一个；
 *   · 空串、纯空白、`undefined` 一律算"没有这个键"（后端 `nickname.trim().is_empty()`
 *     那一步同口径，接口给了空串也不该印一片空白）；
 *   · 站点级那份也没有（redux 未加载完）⇒ 返回空串，调用方照旧渲染（与改造前的行为一致，
 *     antd `Avatar` 没有 `src` 时画默认头像，这是既有外观）。
 */
export interface SiteAuthor {
    /** 站点级署名（redux `state.user.name`），老文章的署名就是它 */
    name?: string | null
    /** 站点级头像（redux `state.user.avatar`） */
    avatar?: string | null
}

export interface NoteAuthor {
    name: string
    avatar: string
}

/** 非空判据：`undefined`/`null`/空串/纯空白都算"没记录"。 */
const given = (v: string | null | undefined): string => (v ?? "").trim()

/**
 * 这篇文章该显示谁：**优先文章作者，没有记录（老文章 / 发布者已销号 / 这一路接口没回键）
 * 才回退站点级**。传入 `item` 可以是任意一张文章行（`NoteType` 或接口原始行都行）。
 */
export function noteAuthor(
    item: Partial<NoteType> | null | undefined,
    site: SiteAuthor,
): NoteAuthor {
    const siteName = given(site?.name)
    const siteAvatar = given(site?.avatar)
    return {
        name: given(item?.authorName) || siteName,
        avatar: given(item?.authorAvatar) || siteAvatar,
    }
}
