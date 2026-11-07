import {describe, expect, it} from 'vitest'
import {diagnosticUrl, resourceFailure, shapeReport} from '../../src/utils/reportCore'

describe('resource diagnostics privacy', () => {
    const signed = 'https://user:password@images.example/api/image_review/123?token=PRIVATE_REVIEW_TOKEN&other=secret#fragment'
    const safe = 'https://images.example/api/image_review/123'
    it('keeps origin/path for investigation and drops all credentials/query/fragment', () => {
        expect(diagnosticUrl(signed)).toBe(safe)
        expect(resourceFailure({target: {tagName: 'IMG', currentSrc: signed}})).toEqual({tag: 'IMG', url: safe})
        expect(diagnosticUrl('/article/54?draft=secret#heading')).toBe('/article/54')
        expect(diagnosticUrl('//user:password@images.example/a.png?token=secret')).toBe('//images.example/a.png')
    })
    it('removes signed sources from every report field, including message and stack', () => {
        const report = shapeReport({type: 'resource_error', url: signed,
            message: 'image failed '+signed, stack: 'at image '+signed}, 'https://blog.example/article/54?token=PAGE_TOKEN', null)
        expect(report.url).toBe(safe)
        expect(report.message).toBe('image failed '+safe)
        expect(report.stack).toBe('at image '+safe)
        for (const secret of ['PRIVATE_REVIEW_TOKEN', 'password', '?', 'PAGE_TOKEN', 'fragment']) expect(JSON.stringify(report)).not.toContain(secret)
    })
    it('redacts inline and blob data instead of storing pixels or opaque identifiers', () => {
        for (const source of ['data:image/svg+xml,<svg>PRIVATE_PIXELS</svg>', 'blob:https://blog.example/PRIVATE_BLOB']) {
            const report = shapeReport({type: 'resource_error', url: source, message: 'failed '+source, stack: source}, '/article/54', null)
            expect(JSON.stringify(report)).not.toContain('PRIVATE_')
            expect(report.url).toMatch(/^(data|blob):\[redacted\]$/)
        }
    })
    it('sanitizes embedded links even when the explicit report URL is the page', () => {
        const report = shapeReport({type: 'resource_error', message: signed, stack: '/api/image_review/123?token=PRIVATE_REVIEW_TOKEN'}, '/article/54?preview=secret', null)
        expect(report.message).toBe(safe)
        expect(report.stack).toBe('/api/image_review/123')
        expect(report.url).toBe('/article/54')
        expect(diagnosticUrl('https://[invalid?token=secret')).toBe('[invalid-url]')
    })
})
