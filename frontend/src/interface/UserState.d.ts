import {SocialType} from "./SocialType";

export default interface UserState{
    token: string | null;
    avatar: string;
    talk: string;
    name: string;
    social: SocialType | null;
    blogTitle: string;
    blogIcp: string;
    /** 公安网安备案号（20260930）。**空串 = 没配 = 页脚整块不渲染**——
     *  这不是每个站都有的东西，更不该由仓库带一个别人的。 */
    blogPublicIcp: string;
    /** 版权署名（20260930）。空串时页脚回退到 `name`（= blogAuthor）——
     *  署名总得有，但"具体是谁"属于部署者自己，不进仓库。 */
    blogCopyright: string;
}
