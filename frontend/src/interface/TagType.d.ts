import {TreeDataNode} from "antd";

type Color = {
    toHexString: () => string
}
export interface TagLevelOne extends TreeDataNode{
    key: number,
    color: string
    level: number
    title: string
    children: TagLevelTwo[]
}

//二级标签
export interface TagLevelTwo {
    key: number;
    level: number;
    title: string;
    color: string;
    /** 父标签**名字**（只作展示/兼容；建树一律用 fatherKey） */
    fatherTag: string;
    /** 父标签 **id**（20260919 起后端返回），建树的正确键 */
    fatherKey?: number;
}

export interface newTag {
    level: string
    title: string;
    key: number;
    color: Color;
    children?: TagLevelTwo[]
    fatherTag?: number
}