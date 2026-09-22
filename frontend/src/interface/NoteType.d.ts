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
}