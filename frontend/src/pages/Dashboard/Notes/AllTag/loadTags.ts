import http from '../../../../apis/axios';
import type { Envelope } from '../../../../apis/ProfileMethods';
import { ok, errMsg } from '../../../../apis/ProfileMethods';
import type { TagLevelOne } from '../../../../interface/TagType';

type RawTag = { tagKey: number; title: string; level: number; color: string; fatherKey?: number; fatherTag?: string };
/** Unlike the legacy initTree helper, failed reads stay failures instead of becoming an empty tag tree. */
export async function loadTags(): Promise<TagLevelOne[]> {
    const [parents, children] = await Promise.all([
        http<Envelope<RawTag[]>>({ url: '/api/public/tagone', method: 'GET' }),
        http<Envelope<RawTag[]>>({ url: '/api/public/tagtwo', method: 'GET' }),
    ]);
    for (const response of [parents, children]) {
        if (!ok(response) || !Array.isArray(response.data.data)) throw new Error(errMsg(response, '标签加载失败'));
    }
    return parents.data.data.map(one => ({
        key: one.tagKey, title: one.title, level: one.level, color: one.color,
        children: children.data.data.filter(two => two.fatherKey != null ? two.fatherKey === one.tagKey : two.fatherTag === one.title).map(two => ({
            key: two.tagKey, title: two.title, level: two.level, color: two.color, fatherKey: two.fatherKey, fatherTag: two.fatherTag || '',
        })),
    }));
}
