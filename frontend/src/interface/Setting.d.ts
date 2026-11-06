/** 站点设置页载荷；账号凭据在登录和个人中心维护，模型凭据由服务配置提供。 */
export interface webInfo{
    blogTitle: string;
    blogAuthor: string;
    blogIcp: string;
    blogPublicIcp: string;
    blogCopyright: string;
    userTalk: string;
    socialGithub: string;
    socialEmail: string;
    socialBilibili: string;
    socialQQ: string;

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
    credsSource?: string | null;
    bucket: string;
    prefix: string;
    publicBase: string;
    quotaGB: number;
    limitBytes: number;
    usedBytes: number;
    listError?: string | null;
}
