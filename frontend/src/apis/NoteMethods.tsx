import http from "./axios.tsx";
import React from "react";
interface status{
    isTop: number
    status: string
    updateTime: string
}

interface updateNote{
    noteTitle: any;
    noteContent: string;
    cover: string;
    // 封面裁剪参数（焦点归一化坐标 + 额外缩放倍数），null = 不改动
    coverFocusX?: number | null;
    coverFocusY?: number | null;
    coverZoom?: number | null;
    // 置顶轮播那套（与 cover_* 分立，三列同进同出）
    carouselFocusX?: number | null;
    carouselFocusY?: number | null;
    carouselZoom?: number | null;
    description: string;
    noteCategory: any;
    noteTags: string;
    isTop: number;
    status: any;
    updateTime: string;
}

interface newNote{
    noteTitle: any;
    noteContent: string;
    cover: string;
    coverFocusX?: number | null;
    coverFocusY?: number | null;
    coverZoom?: number | null;
    carouselFocusX?: number | null;
    carouselFocusY?: number | null;
    carouselZoom?: number | null;
    description: string;
    noteCategory: any;
    noteTags: string;
    isTop: number;
    status: any;
    createTime: string;
    updateTime: string;
}

// 自动保存（草稿）：只带编辑器里有的字段，后端按 id 决定写到哪一行
// （新建→建一行草稿；编辑草稿→原地更新；编辑已发布/私密→落到它的「修改稿」行）
export interface AutosaveDraftPayload{
    id?: number | null;
    noteTitle?: string;
    noteContent?: string;
    cover?: string;
    coverFocusX?: number | null;
    coverFocusY?: number | null;
    coverZoom?: number | null;
    carouselFocusX?: number | null;
    carouselFocusY?: number | null;
    carouselZoom?: number | null;
    description?: string;
    noteCategory?: number | null;
    noteTags?: string;
    isTop?: number;
}

function getNotes(){
    return http({
        url: '/api/public/notes',
        method: 'GET'
    })
}

function delNote(key: number){
    return http({
        url: '/api/protected/notes',
        method: 'DELETE',
        data: [key]
    })
}

function delAllNotes(selectedRowKeys: React.Key[]){
    return http({
        url: '/api/protected/notes',
        method: 'DELETE',
        data: selectedRowKeys
    })
}

function updateNoteStatus(data: status,isEdit:string){
    return http({
        url: `/api/protected/notes/${isEdit}`,
        method: 'POST',
        data: data
    })
}

function getNoteById(id: string){
    return http({
        url: `/api/public/notes/${id}`,
        method: 'GET'
    })
}

function updateNote(id:string,update: updateNote){
    return http({
        url: `/api/protected/notes/${id}`,
        method: 'POST',
        data: update
    })
}

function createNote(data: newNote){
    return http({
        url: '/api/protected/notes',
        method: 'POST',
        data: data
    })
}

function searchNotes(data:any){
    return http({
        url: '/api/public/notes/search',
        method: 'POST',
        data: data
    })
}

interface page{
    page: number
    pageSize: number
}
function getNotePage(data?:page){
    return http({
        url: '/api/public/notes/page',
        method: 'GET',
        params: data
    })
}

function getTopNotes(){
    return http({
        url: '/api/public/topnotes',
        method: 'GET',
    })
}

function getAllNotes(){
    return http({
        url: '/api/public/notes',
        method: 'GET',
    })
}

// 自动保存草稿（编辑中的文章落到草稿箱）
function autosaveDraft(data: AutosaveDraftPayload){
    return http({
        url: '/api/protected/draft/autosave',
        method: 'POST',
        data: data
    })
}

// 编辑器专用读入口：公开的 /api/public/notes/:id 会挡掉草稿/私密文章（A4 过滤），
// 草稿箱点进去会 404。返回 { note, draft }（draft = 待继续编辑的修改稿或 null）
function getNoteForEdit(id: string){
    return http({
        url: `/api/protected/draft/editor/${id}`,
        method: 'GET'
    })
}

// NEW ADMIN METHODS
function getAdminNotes(){
    return http({
        url: '/api/protected/notes/list',
        method: 'GET'
    })
}

function searchAdminNotes(data:any){
    return http({
        url: '/api/protected/notes/search',
        method: 'POST',
        data: data
    })
}

export {getNotes,delNote,delAllNotes,updateNoteStatus,getNoteById,updateNote,createNote,searchNotes,getNotePage,getTopNotes,getAllNotes,getAdminNotes,searchAdminNotes,autosaveDraft,getNoteForEdit}
