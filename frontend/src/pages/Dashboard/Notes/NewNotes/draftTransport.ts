import type {AutosaveDraftPayload} from '../../../../apis/NoteMethods';

// Fetch 的 keepalive 限额按 UTF-8 字节计，同一 fetch group 中多个请求共享 64KiB。
// 留余量仍不能保证浏览器接收请求；调用方必须等待业务回执，未确认时保持脏状态。
export const DRAFT_KEEPALIVE_BYTES = 60_000;
export async function postDraftKeepalive(
    payload: AutosaveDraftPayload,
    baseURL: string,
    token: string | null,
) {
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).byteLength > DRAFT_KEEPALIVE_BYTES) {
        throw new Error('草稿超过 keepalive 字节限制，返回页面后重试');
    }
    if (!token) throw new Error('登录状态失效');
    const response = await fetch(`${baseURL}/api/protected/draft/autosave`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
        },
        body,
        keepalive: true,
    });
    return {status: response.status, data: await response.json()};
}
