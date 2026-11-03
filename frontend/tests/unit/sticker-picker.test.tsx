import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StyleProvider } from '@ant-design/cssinjs/lib/index.js'
import { expect, it, vi } from 'vitest'
import { STICKER_NAMES } from '../../src/utils/stickers'
import StickerPicker from '../../src/components/CommentSection/StickerPicker'

it('opens outside the composer, inserts one sticker and restores keyboard focus', async () => {
    const pick = vi.fn(), submit = vi.fn(event => event.preventDefault())
    render(<StyleProvider mock="server"><form onSubmit={submit} data-testid="composer">
        <StickerPicker onPick={pick} />
    </form></StyleProvider>)
    const trigger = screen.getByRole('button', {name: /表情/})
    fireEvent.click(trigger)
    const panel = await screen.findByRole('dialog', {name: '选择站内表情'})
    expect(screen.getByTestId('composer').contains(panel)).toBe(false)
    const item = within(panel).getAllByRole('button')[0]
    fireEvent.click(item)
    expect(pick).toHaveBeenCalledTimes(1)
    expect(pick).toHaveBeenCalledWith(STICKER_NAMES[0])
    expect(submit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
})

it('Escape closes without selection; disabled picker never opens', async () => {
    const pick = vi.fn()
    const view = render(<StyleProvider mock="server"><StickerPicker onPick={pick} /></StyleProvider>)
    const trigger = screen.getByRole('button', {name: /表情/})
    fireEvent.click(trigger)
    const panel = await screen.findByRole('dialog')
    fireEvent.keyDown(panel, {key: 'Escape'})
    expect(pick).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
    view.rerender(<StyleProvider mock="server"><StickerPicker onPick={pick} disabled /></StyleProvider>)
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
})
