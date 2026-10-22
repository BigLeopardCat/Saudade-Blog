/** Only a confirmed ApiResponse success may close a form or clear its selection. */
export async function runAdminMutation(
    lock: { current: boolean },
    setBusy: (busy: boolean) => void,
    request: () => Promise<{ status: number; data?: { code?: number; message?: string } }>,
    onSuccess: () => void,
    onError: (message: string) => void,
): Promise<boolean> {
    // A ref, rather than rendered state, also rejects two clicks in the same frame.
    if (lock.current) return false
    lock.current = true
    setBusy(true)
    try {
        const response = await request()
        if (response.status !== 200 || response.data?.code !== 200) {
            onError(response.data?.message?.trim() || '操作失败，请稍后重试')
            return false
        }
        onSuccess()
        return true
    } catch (error) {
        // Ant Design validation already shows the error next to the field.
        if (!(error && typeof error === 'object' && 'errorFields' in error)) {
            onError('请求失败，请检查网络后重试')
        }
        return false
    } finally {
        lock.current = false
        setBusy(false)
    }
}
