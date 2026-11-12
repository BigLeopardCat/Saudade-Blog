import http from "./axios.tsx";
import {TagLevelOne, TagLevelTwo} from "../interface/TagType";
import React from "react";
import type {NoteTagRef} from "../interface/NoteType";
import {Popover, Tag} from "antd";

interface addNewTagOne{
    title: string,
    color: string,
}
interface addNewTagTwo{
    title: string,
    color: string,
    /** 父标签 id（后端字段名沿用了 fatherTag，值其实是 `tag_one.id`） */
    fatherTag: number
}

/** 两级标签 id 各自自增；纯 id 映射以一级优先。 */
export interface TagOption {
    value: number;
    /** **显示用的名字 = 标签自己的名字**，两级一视同仁（见 `flattenTagOptions` 头注） */
    label: string;
    /** **搜索用的词**（二级额外带上父名，所以搜父名也能命中它）。`NoteTagSelect` 靠它过滤 */
    keywords: string;
    color?: string;
    level: 1 | 2;
}

// 获取一级标签
async function getTagOne() {
    try {
        const response = await http({
            url: '/api/public/tagone',
            method: 'GET'
        });
        return response.data.data.map((item: { tagKey: number; title: string; level: number; color: string; }) => ({
            key: item.tagKey,
            title: item.title,
            level: item.level,
            color: item.color,
            children: []
        }));
    } catch (error) {
        console.error("Error fetching tag one data:", error);
        return [];
    }
}
// 新增一级标签
function addTagOne(newTag: addNewTagOne){
    return http({
        url: '/api/protected/tagone',
        method: 'POST',
        data: newTag
    })
}
// 获取二级标签
async function getTagTwo() {
    try {
        const response = await http({
            url: '/api/public/tagtwo',
            method: 'GET'
        });
        return response.data.data.map((item: { tagKey: number; title: string; level: number; color: string; fatherTag: string; fatherKey?: number }) => ({
            key: item.tagKey,
            title: item.title,
            level: item.level,
            color: item.color,
            fatherTag: item.fatherTag,
            fatherKey: item.fatherKey
        }));
    } catch (error) {
        console.error("Error fetching tag two data:", error);
        return []; // or handle error as needed
    }
}
// 新增二级标签
async function addTagTwo(newTag: addNewTagTwo){
    return http({
        url: '/api/protected/tagtwo',
        method: 'POST',
        data: newTag
    })
}
/** 按 fatherKey 建立标签树；父 id 缺失时回退为父名匹配。 */
function buildTagTree(tagOneData: TagLevelOne[],tagTwoData: TagLevelTwo[]){
    return tagOneData.map(item => {
        item.children = tagTwoData.filter(child =>
            child.fatherKey !== undefined && child.fatherKey !== null
                ? child.fatherKey === item.key
                : child.fatherTag === item.title
        );
        return item;
    });
}
// 初始化树
async function initTree(){
    const tagOneData: TagLevelOne[] = await getTagOne();
    const tagTwoData: TagLevelTwo[] = await getTagTwo();
    return buildTagTree(tagOneData,tagTwoData)
}
/** 按指定层级删除标签及其引用，避免同 id 的跨级误删。 */
function delTag(level: 'one' | 'two', ids: React.Key[]) {
    return http({
        url: '/api/protected/tag',
        method: 'DELETE',
        data: { level, ids }
    })
}

function flattenTagOptions(tagList: any): TagOption[] {
    const out: TagOption[] = [];
    const seen = new Set<number>();
    const dup: number[] = [];
    const push = (id: number, label: string, color: string | undefined, level: 1 | 2,
                  keywords: string = label) => {
        if (!Number.isInteger(id) || id <= 0) return;
        if (seen.has(id)) { dup.push(id); return; }
        seen.add(id);
        out.push({ value: id, label, keywords, color, level });
    };
    (Array.isArray(tagList) ? tagList : []).forEach((one: any) => {
        const oneId = Number(one?.tagKey ?? one?.key);
        push(oneId, String(one?.title ?? ''), one?.color, 1);
        (Array.isArray(one?.children) ? one.children : []).forEach((two: any) => {
            const twoId = Number(two?.tagKey ?? two?.key);
            push(twoId, String(two?.title ?? ''), two?.color, 2, `${one?.title} ${two?.title}`);
        });
    });
    if (dup.length > 0) {
        console.warn('标签 id 在两级之间重号，已丢弃后出现的条目：', dup);
    }
    return out;
}

/** id → 标签（一级优先），渲染用 */
function tagLabelMap(tagList: any): Map<number, TagOption> {
    const map = new Map<number, TagOption>();
    flattenTagOptions(tagList).forEach(opt => map.set(opt.value, opt));
    return map;
}

/** Prefer level/id identities supplied by the article API; older rows use the catalog. */
function noteTagOptions(noteTags: number[], tagList: any, refs?: NoteTagRef[]) {
    if (Array.isArray(refs)) {
        const seen = new Set<string>();
        return refs.flatMap(ref => {
            const key = `${ref.level}:${ref.id}`;
            if (!Number.isInteger(ref.id) || ref.id <= 0 || ![1, 2].includes(ref.level)
                || !ref.name || seen.has(key)) return [];
            seen.add(key);
            return [{key, label: ref.name, color: ref.color ?? undefined}];
        });
    }
    const labels = tagLabelMap(tagList);
    return [...new Set(Array.isArray(noteTags) ? noteTags : [])].flatMap(id => {
        const opt = labels.get(id);
        return opt ? [{key: String(id), label: opt.label, color: opt.color}] : [];
    });
}

function renderNoteTags(noteTags: number[], tagList: any, refs?: NoteTagRef[]) {
    return noteTagOptions(noteTags, tagList, refs).map(opt =>
        <Tag color={opt.color} key={opt.key}>{opt.label}</Tag>);
}

/** Keep article lists compact while preserving the complete ordered tag list. */
function renderNoteTagsCollapsed(noteTags: number[], tagList: any, max: number = 3, refs?: NoteTagRef[]) {
    const options = noteTagOptions(noteTags, tagList, refs);
    if (options.length === 0) return <span style={{opacity: .45}}>—</span>;
    const shown = options.slice(0, max);
    const rest = options.slice(max);
    return <span style={{display: 'inline-flex', alignItems: 'center', flexWrap: 'nowrap', maxWidth: '100%', overflow: 'hidden'}}>
        {shown.map(opt => <Tag color={opt.color} key={opt.key} style={{marginInlineEnd: 4, marginBottom: 0}}>{opt.label}</Tag>)}
        {rest.length > 0 && <Popover placement="top" content={
            <div style={{maxWidth: 260, display: 'flex', flexWrap: 'wrap', gap: 4}}>
                {options.map(opt => <Tag color={opt.color} key={opt.key} style={{margin: 0}}>{opt.label}</Tag>)}
            </div>}>
            <Tag style={{marginInlineEnd: 0, marginBottom: 0, cursor: 'pointer'}}>+{rest.length}</Tag>
        </Popover>}
    </span>;
}

// 更新一级标签
function updateTagOne(id: number, data: { title: string; color: string }) {
    return http({
        url: `/api/protected/tagone/${id}`,
        method: 'PUT',
        data: data
    })
}

// 更新二级标签
function updateTagTwo(id: number, data: { title: string; color: string }) {
    return http({
        url: `/api/protected/tagtwo/${id}`,
        method: 'PUT',
        data: data
    })
}

export {getTagOne,getTagTwo,buildTagTree,delTag,initTree,addTagOne,addTagTwo,renderNoteTags,renderNoteTagsCollapsed,flattenTagOptions,tagLabelMap,updateTagOne,updateTagTwo}
