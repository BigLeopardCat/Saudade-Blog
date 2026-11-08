import type {AxiosResponse} from 'axios'
import {currentPrivateOwner, privateApi} from './privateApi'
import {getLiveAuthToken} from '../utils/useAuthToken'
import http from './axios'

export interface CommentAdminItem {
    id: number; noteId: number; noteTitle: string; content: string;
    userId: number; username: string; nickname: string; replyToNickname?: string | null;
    createTime: string; approved: number; aiResult?: string | null;
    rejectReason?: string | null; aiReason?: string | null; isDeleted: number;
}
export type CommentFilter = 'all' | 'pending' | 'passed' | 'rejected' | 'deleted'
export interface CommentPageArgs {
    ownerUserId: number; page: number; status: CommentFilter; query: string; sort: 'asc' | 'desc';
}
export const COMMENT_PAGE_SIZE = 10
interface CommentPage {items: CommentAdminItem[]; total: number}
interface Envelope<T> {code: number; message?: string; data: T; total?: number}

async function owned<T>(owner: number, read: () => Promise<AxiosResponse<Envelope<T>>>) {
    const token = getLiveAuthToken()
    if (!token || currentPrivateOwner() !== owner) throw new Error('登录状态已变化')
    const response = await read()
    if (getLiveAuthToken() !== token || currentPrivateOwner() !== owner) throw new Error('登录状态已变化')
    if (response.status !== 200 || response.data?.code !== 200) {
        throw new Error(response.data?.message || '评论请求失败，请重试')
    }
    return response.data
}
const failure = (error: unknown) => ({error: {message: error instanceof Error ? error.message : '评论请求失败，请重试'}})

export const commentAdminApi = privateApi.enhanceEndpoints({addTagTypes: ['Comments']}).injectEndpoints({
    endpoints: build => ({
        adminComments: build.query<CommentPage, CommentPageArgs>({
            async queryFn({ownerUserId, page, status, query, sort}, {signal}) {
                try {
                    const body = await owned<CommentAdminItem[]>(ownerUserId, () => http.get('/api/protect/comments', {
                        signal, params: {
                            page, page_size: COMMENT_PAGE_SIZE, q: query || undefined, sort,
                            status: status === 'all' || status === 'deleted' ? undefined : status,
                            deleted: status === 'all' ? undefined : status === 'deleted',
                        },
                    }))
                    if (!Array.isArray(body.data) || body.data.length > COMMENT_PAGE_SIZE
                        || !Number.isSafeInteger(body.total) || body.total! < 0
                        || body.total! < body.data.length
                        || !body.data.every(row => row && Number.isSafeInteger(row.id) && row.id > 0
                            && Number.isSafeInteger(row.noteId) && row.noteId > 0
                            && Number.isSafeInteger(row.userId) && row.userId > 0
                            && ['noteTitle', 'content', 'username', 'nickname', 'createTime'].every(key => typeof row[key as keyof CommentAdminItem] === 'string')
                            && [0, 1, 2].includes(row.approved) && Number.isInteger(row.isDeleted))) throw new Error('评论分页数据无效，请重试')
                    return {data: {items: body.data, total: body.total!}}
                } catch (error) { return failure(error) }
            },
            providesTags: (_data, _error, arg) => [{type: 'Comments', id: arg.ownerUserId}],
        }),
        auditComment: build.mutation<string, {ownerUserId: number; id: number; approved: number; reason?: string}>({
            async queryFn({ownerUserId, id, approved, reason}, {signal}) {
                try {
                    const body = await owned<string>(ownerUserId, () => http.put(`/api/protect/comments/${id}/audit`, {approved, reason}, {signal}))
                    return {data: body.data}
                } catch (error) { return failure(error) }
            },
            invalidatesTags: (_data, error, arg) => error ? [] : [{type: 'Comments', id: arg.ownerUserId}],
        }),
        deleteComment: build.mutation<string, {ownerUserId: number; id: number}>({
            async queryFn({ownerUserId, id}, {signal}) {
                try {
                    const body = await owned<string>(ownerUserId, () => http.delete(`/api/protect/comments/${id}`, {signal}))
                    return {data: body.data}
                } catch (error) { return failure(error) }
            },
            invalidatesTags: (_data, error, arg) => error ? [] : [{type: 'Comments', id: arg.ownerUserId}],
        }),
    }),
})

export const {useAdminCommentsQuery, useAuditCommentMutation, useDeleteCommentMutation} = commentAdminApi
