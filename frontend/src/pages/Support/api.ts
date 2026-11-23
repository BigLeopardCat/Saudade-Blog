import {useEffect, useRef, useState} from 'react';
import {clearAuthToken} from '../../utils/authSession';
import {getLiveAuthToken} from '../../utils/useAuthToken';
import {runtimeBaseURL} from '../../utils/runtimeApi';

export type CaseKind = 'question' | 'ticket';
export type Status = 'waiting_staff' | 'waiting_user' | 'resolved';
export type Action = 'reply' | 'escalate' | 'resolve' | 'reopen';
export interface Ticket {id: number; ownerId: number; kind: CaseKind; subject: string; status: Status; version: number; updatedAt: string}
export interface Entry {id: number; sender: 'customer' | 'staff'; action: Action | 'open_question' | 'open_ticket'; body: string; createdAt: string}
export interface Page<T> {items: T[]; nextBefore: number | null}
export interface Detail {case: Ticket; events: Page<Entry>; guidance?: {topic: Topic | null} | null}
export interface Topic {id: string; question: string; answer: string; href: string}

class SupportError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}
async function request<T>(path: string, token: string | null, init: RequestInit): Promise<T> {
    if (token && token !== getLiveAuthToken()) throw new Error('登录状态已变化');
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (init.body) headers['Content-Type'] = 'application/json';
    const response = await fetch(runtimeBaseURL + path, {...init, headers, cache: 'no-store'});
    if (token && getLiveAuthToken() !== token) throw new Error('登录状态已变化');
    if (response.status === 401 && token) clearAuthToken(token);
    const envelope = await response.json().catch(() => null);
    if (!response.ok || envelope?.code !== 200) {
        throw new SupportError(envelope?.message || (response.status === 403 ? '无权访问' : '客服服务暂时不可用'), response.status);
    }
    return envelope.data as T;
}

export function useRead<T>(path: string, token: string | null, revision: number, poll = false) {
    const [result, setResult] = useState<{path: string; revision: number; data?: T; error?: string}>();
    useEffect(() => {
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        async function load() {
            try {
                const data = await request<T>(path, token, {signal: abort.signal});
                if (!abort.signal.aborted) setResult({path, revision, data});
            } catch (error) {
                if (!abort.signal.aborted) setResult({path, revision, error: error instanceof Error ? error.message : '客服服务暂时不可用'});
            }
            if (poll && !abort.signal.aborted) schedule();
        }
        function schedule() {
            timer = setTimeout(() => { if (document.hidden) schedule(); else void load(); }, 10000);
        }
        void load();
        return () => {abort.abort(); clearTimeout(timer);};
    }, [path, token, revision, poll]);
    return result?.path === path && result.revision === revision ? result : undefined;
}

// Reusing an uncertain request allows a lost response to be reconciled by the server.
export function useWrite(token: string) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const pending = useRef(false);
    const last = useRef<{intent: string; key: string} | null>(null);
    async function send(path: string, body: Record<string, unknown>, onConflict?: () => void): Promise<Ticket | undefined> {
        if (pending.current) return;
        const intent = JSON.stringify([path, body]);
        if (last.current?.intent !== intent) last.current = {intent, key: crypto.randomUUID()};
        pending.current = true;
        setBusy(true);
        setError('');
        try {
            const record = await request<Ticket>(path, token, {method: 'POST', body: JSON.stringify({...body, requestId: last.current.key})});
            last.current = null;
            return record;
        } catch (e) {
            setError(e instanceof Error ? e.message : '客服服务暂时不可用');
            if (e instanceof SupportError && e.status === 409) onConflict?.();
        } finally {
            pending.current = false;
            setBusy(false);
        }
    }
    return {busy, error, send};
}
