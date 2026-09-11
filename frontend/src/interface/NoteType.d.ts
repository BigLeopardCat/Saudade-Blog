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
    noteKey: string
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