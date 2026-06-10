import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { Dispatch } from 'react';
import {NoteType} from "../../interface/NoteType";
import {getNotes, getAdminNotes} from "../../apis/NoteMethods.tsx";


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

const fetchNoteList = () => {
    return async (dispatch: Dispatch<PayloadAction<NoteType[]>>) => {
        try {
            // Check if admin token exists
            const token = localStorage.getItem('tokenKey');
            let res;
            if (token) {
                 // Use admin API if logged in
                 res = await getAdminNotes();
            } else {
                 res = await getNotes();
            }

            const noteList = Array.isArray(res?.data?.data) ? res.data.data : [];
            const processedData = noteList.map((item: { noteTags: string; }) => ({
                ...item,
                noteTags: item.noteTags ? item.noteTags.split(',').map(tag => parseInt(tag, 10)) : [],
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
