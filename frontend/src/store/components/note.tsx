import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { Dispatch } from 'react';
import {NoteType} from "../../interface/NoteType";
import {getNotes, getAdminNotes} from "../../apis/NoteMethods.tsx";
import {parseNoteTags} from "../../utils/noteTags";


interface noteList {
    Notes: NoteType[],
    noteCount: number
}

const init: noteList = {
    Notes: [],
    noteCount: 0
}


const NoteSlice = createSlice({
    name: "Note",
    initialState: init,
    reducers: {
        setNote: (state,action:PayloadAction<NoteType[]>) => {
            state.Notes = action.payload
        },
        setNoteCount: (state,action) => {
            state.noteCount = action.payload
        }
    }
})

const fetchNoteList = (admin = false) => {
    return async (dispatch: Dispatch<PayloadAction<NoteType[]>>) => {
        try {
              // 登录不等于管理员权限：前台始终使用公开列表，后台显式请求管理员列表。
              const res = admin ? await getAdminNotes() : await getNotes();

            const noteList = Array.isArray(res?.data?.data) ? res.data.data : [];
            const processedData = noteList.map((item: { noteTags: string; }) => ({
                ...item,
                noteTags: parseNoteTags(item.noteTags),
            }));
            dispatch(setNote(processedData));
            dispatch(setNoteCount(processedData.length));
        } catch (err) {
            console.error('Error fetching note list:' + err);
        }
    };
}

const {setNote,setNoteCount} = NoteSlice.actions
const NoteReducer = NoteSlice.reducer


export {setNote, fetchNoteList};
export default NoteReducer;
export type { noteList };
