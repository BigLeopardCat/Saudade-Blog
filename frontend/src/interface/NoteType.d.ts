export interface NoteType {
    noteCategory?: string;
    categoryTitle?: string;
    updateTime: Date;
    noteTitle: string;
    description: string;
    noteTags: number[];
    key: string;
    cover: string;
    // 封面裁剪参数（焦点归一化坐标 + 额外缩放倍数），null/缺省 = 未设置（按居中 cover 渲染）
    coverFocusX?: number | null;
    coverFocusY?: number | null;
    coverZoom?: number | null;
    categories: string;
    isTop: boolean | number;
    createTime: Date;
    status: string;
    content: string;
    // 正文的另一个副本：详情/列表接口两个键都回（Rust 侧 DTO 里 content 与 noteContent 并存），
    // 文章页读的是这一个
    noteContent?: string;
    noteKey: string
    // 编辑修改稿链接：有值 = 本行是那篇文章（id）的自动保存修改稿
    draftOf?: number | null;
    // 卡片上的三个数（20260930）。**只有公开列表接口会回**，详情接口连键都没有 ⇒
    // 这里的可选性是契约本身（不是"忘写了"）：`undefined` = 这一路没有这个数，
    // 卡片据此整个不渲染那一排；`0` = 真的是 0，照常显示。
    views?: number;
    likes?: number;
    favorites?: number;
    // 这篇文章的作者（20261001）。**判据是"谁发的"**：发布那一刻的操作者，不是站点主人。
    // 可选的理由与上面三个数同源：文章没有作者记录（本列之前发布的老文章 / 发布者账号已销）
    // 或这次没查着 ⇒ 键不出现，卡片回退站点级署名（`utils/noteAuthor.ts` 是唯一判据）。
    // **两个键成对回**（后端 `attach_authors` 两个分支各写一对），且**键在场时空值是空值**：
    // 发布者没上传过头像 ⇒ `authorAvatar` 是空串（不是缺席），卡片画 antd 默认头像，
    // 不顶站点主人那张脸——判据按"键在不在场"分支，不按值空不空。
    authorName?: string;
    authorAvatar?: string;
}

export interface formatNote {
    noteKey: number;
    noteTitle: string;
    noteContent: string;
    description: string;
    cover: string;
    noteCategory: string;
    noteTags: string;
    isTop: number;
    status: string;
    createTime: Date;
    updateTime: Date | string;
    // 列表接口附带的三个人数（20260930，见上面 NoteType 里那段）；`formatNote` 是
    // **接口原始行**的类型，所以这里必须有——ContentHome 是 `{...item}` 透传的，
    // 缺了这一行 TS 会认不出，卡片拿到的是 undefined（症状 = 三个数全不显示）。
    views?: number;
    likes?: number;
    favorites?: number;
    // 作者（20261001，见 `NoteType` 里那一段）。ContentHome 是 `{...item}` 透传的，
    // 这里缺一行 TS 就认不出，卡片会拿到 undefined ⇒ 全部退回站点署名（"管理员发的
    // 文章仍显示超级管理员"那副样子原样复发）。
    authorName?: string;
    authorAvatar?: string;
}