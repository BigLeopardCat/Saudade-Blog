/**
 * 站点设置（/dashboard/usercontrol）的读写载荷。**只有这一页用它**。
 *
 * 20260930 瘦身，删掉的字段与理由（**别再捡回来**）：
 *   · blogDomain / blogDescription —— 全仓只有"写"没有"读"，从没有消费方；
 *   · openAiToken / neteaseCookies / githubToken —— 同样是死配置，且本质是凭据
 *     （活已被 agent 的 .env 取代，留着等于把第三方 token 明文存业务库并回传面板）；
 *   · userAccount / userPassword / userNickname / userAvatar —— 账号密码与头像的入口
 *     是登录页与个人中心（`components/UserCenter`）。这里再留一份就是两个入口改同一份数据，
 *     而且后端那条路**绕过登录页直接改 uid=1 的凭据**（后门已随本轮删除）。
 *
 * 新增两项是"部署者自己的身份信息"，刻意不进仓库、由各站自填：
 *   · blogPublicIcp —— 公安网安备案号（为空则页脚整块不渲染）；
 *   · blogCopyright —— 版权署名（为空则前端回退到 blogAuthor）。
 */
export interface webInfo{
    blogTitle: string;
    blogAuthor: string;
    blogIcp: string;
    blogPublicIcp: string;
    blogCopyright: string;
    /** 个性签名。20260930 从已删除的「用户信息」页签迁入「站点信息」。 */
    userTalk: string;
    socialGithub: string;
    socialEmail: string;
    socialBilibili: string;
    socialQQ: string;
}
