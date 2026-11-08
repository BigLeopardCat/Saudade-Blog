import {parseNoteTags} from './noteTags';
import type {NoteType} from '../interface/NoteType';

export function normalizeNoteRows(raw: unknown): NoteType[] {
    if (!Array.isArray(raw)) throw new Error('Invalid article rows');
    return raw.map((item: any) => ({
        ...item,
        key: item?.noteKey,
        noteTags: parseNoteTags(item?.noteTags),
    })) as NoteType[];
}
