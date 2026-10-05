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

    /**
     * 图库 R2 图床（20261006，用户第 3 条）。**五个键名与 Rust `src/r2.rs::R2_KEYS`
     * 逐字相同**——它们同时是 `web_info` 的键名与这个接口的 JSON 字段名，
     * 改名要三处一起（Rust 常量 / 这里 / 图库页那个设置弹窗的提交载荷）。
     *
     * 全部可选：站点设置页（UserControl）提交自己管的字段时不会带这五个，
     * 而接口的语义正是"只写请求里带了的那些"（`Option` + `if let Some`）。
     *
     * ⚠️ **凭据不在这里**：R2_ENDPOINT / R2_ACCESS_KEY / R2_SECRET_KEY 只从服务端
     * `.env` 读，永远不经这个接口——面板会把自己收到的每一行明文回传。
     */
    r2ImageBucket?: string;
    /** 对象键前缀（归一后两端无 `/`；留空 = 未配置 ⇒ 走本地盘） */
    r2ImagePrefix?: string;
    /** 公开访问域名（`https://img.example.com` 这种；**换它会让存量图 URL 失效**） */
    r2ImagePublicBase?: string;
    /** 配额，单位 GB（实为 GiB 口径，见 `utils/r2Quota.ts` 头注） */
    r2ImageQuotaGB?: number;
    /** 总开关。**只有 `true` 为真**（服务端口径，见 `r2::parse_config`） */
    r2ImageEnabled?: boolean;
}

/**
 * `/api/protect/images/r2` 的返回载荷（Rust `routes/upload.rs::R2Usage`）。
 *
 * ⚠️ `usedBytes` 在 `listError` 非空时是 **0**，而 0 不是"用量是 0"的意思 ——
 * 展示一律走 `utils/r2Quota.ts` 的 `usageText`/`uploadBlocked`，它们据 `listError`
 * 分支（这条纪律与全仓"缺键绝不编 0"一致）。
 */
export interface R2Usage {
    enabled: boolean;
    configured: boolean;
    credentials: boolean;
    bucket: string;
    prefix: string;
    publicBase: string;
    quotaGB: number;
    limitBytes: number;
    usedBytes: number;
    listError?: string | null;
}
