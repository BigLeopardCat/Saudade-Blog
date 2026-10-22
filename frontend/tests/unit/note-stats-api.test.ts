import { describe, expect, it, vi } from 'vitest';

const { http } = vi.hoisted(() => ({ http: vi.fn() }));
vi.mock('../../src/apis/axios.tsx', () => ({ default: http }));
import { getNoteStats, reportNoteView, likeNote, unlikeNote, getNoteStatsReport } from '../../src/apis/NoteStatsMethods';
import { VISITOR_HEADER } from '../../src/utils/visitorKey';

describe('anonymous statistics request boundary', () => {
    it('adds a current visitor identity to all four public actions without requiring a token', async () => {
        localStorage.setItem('saudade.visitorKey', 'visitor-first');
        http.mockResolvedValue({ status: 200, data: { code: 200, data: {} } });
        const abort = new AbortController();
        await getNoteStats(7, abort.signal);
        await reportNoteView(7);
        await likeNote(7);
        localStorage.setItem('saudade.visitorKey', 'visitor-second');
        await unlikeNote(7);
        expect(http.mock.calls.map(([request]) => request)).toEqual([
            { url: '/api/public/notes/7/stats', method: 'GET', signal: abort.signal, headers: { [VISITOR_HEADER]: 'visitor-first' } },
            { url: '/api/public/notes/7/view', method: 'POST', headers: { [VISITOR_HEADER]: 'visitor-first' } },
            { url: '/api/public/notes/7/like', method: 'POST', headers: { [VISITOR_HEADER]: 'visitor-first' } },
            { url: '/api/public/notes/7/like', method: 'DELETE', headers: { [VISITOR_HEADER]: 'visitor-second' } },
        ]);
        await getNoteStatsReport();
        expect(http).toHaveBeenLastCalledWith({ url: '/api/protected/stats/notes', method: 'GET' });
    });
    it('preserves business errors and network failures for the caller to handle', async () => {
        const failure = { status: 200, data: { code: 500, message: '账号已被冻结' } };
        http.mockResolvedValueOnce(failure);
        await expect(likeNote(7)).resolves.toBe(failure);
        http.mockRejectedValueOnce(new Error('offline'));
        await expect(reportNoteView(7)).rejects.toThrow('offline');
    });
});
