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
}