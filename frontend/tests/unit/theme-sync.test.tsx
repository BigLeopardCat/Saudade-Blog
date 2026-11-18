import {act, render, screen} from '@testing-library/react'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {readDarkMode, useAutoThemeSwitch, useIsDarkMode} from '../../src/theme'

function ThemePage() {
    const dark = useIsDarkMode()
    useAutoThemeSwitch()
    return <output>{dark ? 'night' : 'day'}</output>
}
beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-17T12:00:00'))
    delete document.documentElement.dataset.sceneDark
})
describe('shared page theme', () => {
    it('hydrates a late-mounted page and updates CSS without a scene picker', () => {
        localStorage.setItem('isDarkMode', 'true')
        const view = render(<ThemePage/>)
        expect(screen.getByText('night')).toBeTruthy()
        expect(document.documentElement.dataset.sceneDark).toBe('true')
        act(() => window.dispatchEvent(new CustomEvent('darkmode-change', {detail: false})))
        expect(screen.getByText('day')).toBeTruthy()
        expect(document.documentElement.dataset.sceneDark).toBe('false')
        expect(localStorage.getItem('isDarkMode')).toBe('false')
        view.unmount()
        render(<ThemePage/>)
        expect(screen.getByText('day')).toBeTruthy()
    })
    it('follows another tab and storage clearing while mounted', () => {
        render(<ThemePage/>)
        act(() => {
            localStorage.setItem('isDarkMode', 'true')
            window.dispatchEvent(new StorageEvent('storage', {key: 'isDarkMode', newValue: 'true'}))
        })
        expect(screen.getByText('night')).toBeTruthy()
        expect(document.documentElement.dataset.sceneDark).toBe('true')
        act(() => {
            localStorage.clear()
            window.dispatchEvent(new StorageEvent('storage', {key: null}))
        })
        expect(screen.getByText('day')).toBeTruthy()
        expect(document.documentElement.dataset.sceneDark).toBe('false')
    })
    it('still switches the current page if persistence is unavailable', () => {
        render(<ThemePage/>)
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable') })
        act(() => window.dispatchEvent(new CustomEvent('darkmode-change', {detail: true})))
        expect(screen.getByText('night')).toBeTruthy()
        expect(document.documentElement.dataset.sceneDark).toBe('true')
    })
    it('can render a page when reading storage is blocked', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable') })
        expect(readDarkMode()).toBe(false)
        render(<ThemePage/>)
        expect(screen.getByText('day')).toBeTruthy()
    })
})
