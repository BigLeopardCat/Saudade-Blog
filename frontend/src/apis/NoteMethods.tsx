import http from "./axios.tsx";
import React from "react";
interface status{
    isTop: number
    status: string
    updateTime: string
    noteTags?: string
}

interface updateNote{
    expectedVersion?: string;
    noteTitle: any;
    noteContent: string;
    cover: string;
    coverFocusX?: number | null;
    coverFocusY?: number | null;
    coverZoom?: number | null;
    coverFit?: 'cover' | 'contain' | null;
    carouselFocusX?: number | null;
    carouselFocusY?: number | null;
    carouselZoom?: number | null;
    carouselFit?: 'cover' | 'contain' | null;
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
    coverFit?: 'cover' | 'contain' | null;
    carouselFocusX?: number | null;
    carouselFocusY?: number | null;
    carouselZoom?: number | null;
    carouselFit?: 'cover' | 'contain' | null;
    description: string;
    noteCategory: any;
    noteTags: string;
    isTop: number;
    status: any;
    createTime: string;
    updateTime: string;
}
export interface AutosaveDraftPayload{
    expectedVersion?: string;
    id?: number | null;
    noteTitle?: string;
    noteContent?: string;
    cover?: string;
    coverFocusX?: number | null;
    coverFocusY?: number | null;
    coverZoom?: number | null;
    coverFit?: 'cover' | 'contain' | null;
    carouselFocusX?: number | null;
    carouselFocusY?: number | null;
    carouselZoom?: number | null;
    carouselFit?: 'cover' | 'contain' | null;
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

function getNoteById(id: string, signal?: AbortSignal){
    return http({
        url: `/api/public/notes/${id}`,
        signal,
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

function searchNotes(data:any, signal?: AbortSignal){
    return http({
        url: '/api/public/notes/search',
        signal,
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

export function getNoteFeed(params: { limit: number; cursor?: string }) {
    return http({ url: '/api/public/notes/feed', method: 'GET', params })
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
function autosaveDraft(data: AutosaveDraftPayload){
    return http({
        url: '/api/protected/draft/autosave',
        method: 'POST',
        data: data
    })
}
function getNoteForEdit(id: string){
    return http({
        url: `/api/protected/draft/editor/${id}`,
        method: 'GET'
    })
}

export {getNotes,delNote,delAllNotes,updateNoteStatus,getNoteById,updateNote,createNote,searchNotes,getNotePage,getTopNotes,getAllNotes,autosaveDraft,getNoteForEdit}
