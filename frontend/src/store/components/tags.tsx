import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import http from '../../apis/axios.tsx';
import { Dispatch } from 'react';
import {TagLevelOne, TagLevelTwo} from "../../interface/TagType";


interface Tag {
    tag: TagLevelOne[],
    tagCount: number
}

const init: Tag = {
    tag: [],
    tagCount: 0
}


const tagSlice = createSlice({
    name: "tags",
    initialState: init,
    reducers: {
        setTags: (state,action:PayloadAction<TagLevelOne[]>) => {
            state.tag = action.payload
        },
        setTagCount: (state,action) => {
            state.tagCount = action.payload
        }
    }
})

const fetchTags = () => {
    return async (dispatch:Dispatch<PayloadAction<TagLevelOne[]>>) => {
        try {
            const tagoneResponse = await http({
                url: '/api/public/tagone',
                method: 'GET'
            });
            if (tagoneResponse?.data?.code !== 200 || !Array.isArray(tagoneResponse.data.data)) return false;
            const tagone = tagoneResponse.data.data;

            const tagtwoResponse = await http({
                url: '/api/public/tagtwo',
                method: 'GET'
            });
            if (tagtwoResponse?.data?.code !== 200 || !Array.isArray(tagtwoResponse.data.data)) return false;
            const tagtwo = tagtwoResponse.data.data;

            // 按父标签 **id** 挂载（fatherKey = tag_two.tag_one_id）。
            // 这里以前是按名字匹配（`child.fatherTag === item.title`）：一级标签一改名，其下
            // 所有二级标签就从每个选择器/列表里集体消失，两个同名一级标签还会共享子标签。
            // fatherKey 缺失时才退回按名字（新前端撞上旧后端的过渡窗口）。
            const tree = tagone.map((item: { children: TagLevelTwo[]; title: string; tagKey: number; key?: number }) => {
                const selfKey = Number(item.tagKey ?? item.key);
                const children = tagtwo.filter((child: { fatherTag: string; fatherKey?: number }) =>
                    child.fatherKey !== undefined && child.fatherKey !== null
                        ? child.fatherKey === selfKey
                        : child.fatherTag === item.title
                );
                return {...item, children};
            });

            const tagCount = tagone.length + tagtwo.length

            dispatch(setTagCount(tagCount))
            dispatch(setTags(tree))
            return true
        } catch (error) {
            console.error('标签加载失败', error)
            return false
        }

    }
}

const {setTags,setTagCount} = tagSlice.actions
const tagReducer = tagSlice.reducer


export {setTags,fetchTags}
export default tagReducer