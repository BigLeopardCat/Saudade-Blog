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
 *   · 回退规则本身是**契约**，与后端 `attach_authors` 的回退链逐字对应。
 *
 * 契约（与 `statCells` 同源的"读不到 ≠ 编一个"取向）：
 *   · **判据是"键在不在场"，不是"值空不空"**。后端**两个键成对写**：都在 = 这一路的作者
 *     信息已经定过稿（那个人自己，或者站点级那一位），照它渲染；都不在 = 这一路根本没挂
 *     作者（老缓存 / 别的列表接口），这时才回退站点级。所以这里也按"在不在场"分支，
 *     不按 `||` 逐字段兜底。
 *   · 因此在场时**空值就是空值**：发布者没上传过头像 ⇒ 画 antd 默认头像，**绝不借站点
 *     主人那张脸**。这正是 20261001 用户报的第二个 bug（"作者头像不对，还是硬编码的？"
 *     ——不是硬编码：jingbao 发的文章，后端按老回退链把站长 Sora Saudade 的头像顶了上来）。
 *     脸指向另一个人比没有脸更糟：空头像看得出"这里没记录"，顶着别人的照片则是**看起来
 *     有据的错信息**。名字同理，在场就照它印（后端保证非空：昵称空时用账号名）。
 *   · 站点级那份也没有（redux 未加载完）⇒ 返回空串，调用方照旧渲染（与改造前的行为一致，
 *     antd `Avatar` 没有 `src` 时画默认头像，这是既有外观）。
 */
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
