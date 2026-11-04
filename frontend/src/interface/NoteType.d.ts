export interface NoteTagRef {
    id: number;
    level: 1 | 2;
    name: string;
    color: string | null;
}

export interface NoteType {
    noteCategory?: string;
    categoryTitle?: string;
    updateTime: Date;
    noteTitle: string;
    description: string;
    noteTags: number[];
    noteTagRefs?: NoteTagRef[];
    key: string;
    cover: string;
    // 封面裁剪参数（焦点归一化坐标 + 额外缩放倍数），null/缺省 = 未设置（按居中 cover 渲染）
    coverFocusX?: number | null;
    coverFocusY?: number | null;
    coverZoom?: number | null;
    coverFit?: 'cover' | 'contain' | null;
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
    is_public?: boolean;
    views?: number;
    likes?: number;
    favorites?: number;
    // 讨论数。**口径 = 公开讨论区看得见的那些**（`approved = 1 AND is_deleted = 0`），
    // 所以卡片上的数一定等于点进去数出来的条数（后端 `attach_stats` 那一条）。
    comments?: number;
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
    noteTagRefs?: NoteTagRef[];
    isTop: number;
    status: string;
    createTime: Date;
    updateTime: Date | string;
    views?: number;
    likes?: number;
    favorites?: number;
    comments?: number;
    authorName?: string;
    authorAvatar?: string;
}