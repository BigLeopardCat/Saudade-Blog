import http from './axios'

export const FEATURED_PHOTO_LIMIT = 12
export interface PhotoSelection {imageId: number; caption: string}
export interface FeaturedPhoto extends PhotoSelection {url: string}

export async function getFeaturedPhotos(signal?: AbortSignal): Promise<FeaturedPhoto[]> {
    const {data} = await http.get('/api/public/featured-photos', {signal})
    if (data.code !== 200 || !Array.isArray(data.data)) throw new Error('精选相册加载失败')
    return data.data
}
