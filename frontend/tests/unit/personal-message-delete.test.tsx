import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StyleProvider } from '@ant-design/cssinjs/lib/index.js'
import { beforeEach, expect, it, vi } from 'vitest'
import DeleteInboxItem from '../../src/components/UserCenter/DeleteInboxItem'

const api = vi.hoisted(() => vi.fn())
vi.mock('../../src/apis/axios', () => ({ default: api }))
const counts = { notifications: 2, messages: 3, total: 5 }
beforeEach(() => api.mockReset())

async function confirmation() {
    fireEvent.click(screen.getByRole('button', { name: /删\s*除/ }))
    const title = await screen.findByText('从你的列表删除？')
    return within(title.closest('.ant-popconfirm') as HTMLElement)
}

it('confirms deletion, reports server counts and does not open the parent row', async () => {
    const removed = vi.fn(), open = vi.fn()
    api.mockResolvedValue({ status: 200, data: { code: 200, data: counts } })
    render(<StyleProvider mock="server"><div onClick={open}>
        <DeleteInboxItem item={{ kind: 'notification', id: 42 }} onRemoved={removed} />
    </div></StyleProvider>)
    const popup = await confirmation()
    expect(api.mock.calls.filter(([args]) => args.method === 'DELETE')).toHaveLength(0)
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(popup.getByRole('button', { name: /删\s*除/ }))
    await waitFor(() => expect(removed).toHaveBeenCalledWith(counts))
    expect(api.mock.calls.filter(([args]) => args.method === 'DELETE').map(([args]) => args))
        .toEqual([{ url: '/api/protected/notifications/42', method: 'DELETE' }])
})

it.each(['inbox', 'outbox'] as const)('keeps %s deletion distinct and leaves rows on failure',
    async folder => {
        const removed = vi.fn()
        api.mockResolvedValue({ status: 200, data: { code: 500, message: '删除暂时不可用' } })
        render(<StyleProvider mock="server"><DeleteInboxItem
            item={{ kind: 'message', id: 7, folder }} onRemoved={removed} /></StyleProvider>)
        const popup = await confirmation()
        fireEvent.click(popup.getByRole('button', { name: /删\s*除/ }))
        await screen.findByText('删除暂时不可用')
        expect(removed).not.toHaveBeenCalled()
        expect(api).toHaveBeenCalledWith({ url: '/api/protected/messages/7', method: 'DELETE',
            params: { folder } })
    })

it('cancel does not dispatch a deletion request', async () => {
    const removed = vi.fn()
    render(<StyleProvider mock="server"><DeleteInboxItem
        item={{ kind: 'notification', id: 1 }} onRemoved={removed} /></StyleProvider>)
    const popup = await confirmation()
    fireEvent.click(popup.getByRole('button', { name: /取\s*消/ }))
    expect(api).not.toHaveBeenCalled()
    expect(removed).not.toHaveBeenCalled()
})
