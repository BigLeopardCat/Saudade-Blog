import {describe, expect, it} from 'vitest'
import {carouselCropOf, coverCropMotionStyle, coverCropStyle, cropFromRow} from '../../src/utils/coverCrop'

describe('cover display metadata', () => {
    it('keeps the whole image without focal transforms when contain is selected', () => {
        const value = cropFromRow({coverFit: 'contain', coverFocusX: 0, coverFocusY: 1, coverZoom: 4})
        expect(coverCropStyle(value)).toEqual({objectFit: 'contain', objectPosition: 'center', transform: 'none'})
        expect(coverCropMotionStyle(value)).toEqual({objectFit: 'contain', objectPosition: 'center', scale: 1})
    })
    it('retains independent carousel modes and falls back to the card only when unset', () => {
        expect(carouselCropOf({coverFit: 'contain'})).toMatchObject({fit: 'contain'})
        expect(coverCropStyle(carouselCropOf({coverFit: 'contain', carouselFit: 'cover'}))).toEqual({})
        expect(carouselCropOf({coverFit: 'cover', carouselFit: 'contain'})).toMatchObject({fit: 'contain'})
    })
    it('preserves existing crops and clamps invalid numbers without altering image URLs', () => {
        const value = cropFromRow({coverFit: 'cover', coverFocusX: -1, coverFocusY: 2, coverZoom: 8})
        expect(value).toEqual({x: 0, y: 1, z: 4})
        expect(coverCropStyle(value)).toMatchObject({objectPosition: '0% 100%', transform: 'scale(4)'})
        expect(cropFromRow({coverFocusX: NaN})).toBeNull()
        expect(coverCropStyle(cropFromRow({}))).toEqual({})
    })
})
