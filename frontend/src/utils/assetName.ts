/**
 * 图库里那张图的**展示名**。
 *
 * 盘上/表里存的是 `/api/protect/download/20260912013218_EMQX.png` —— 上传时给原名压了一个
 * 14 位时间戳前缀（同一张图可以反复上传，靠它区分前后两次）。列表模式下要给人看的是
 * `EMQX.png`，前缀是内部产物。
 *
 * ## 跨语言契约
 *
 * 这条规则**不是**这里发明的：Rust `src/routes/upload.rs::strip_timestamp_prefix` 是同一
 * 条判据（去重/候选筛选在用）。两边必须同形，否则会出现"图库里叫 EMQX.png、去重逻辑却
 * 认不出它"这种对不上的状态。Rust 那边按**字节**判（`bytes.len() > 15 && bytes[14] == b'_'
 * && bytes[..14].all(is_ascii_digit)`），这边按 UTF-16 码元判 —— 两者等价：前缀必须全是
 * ASCII 数字，第 15 个字符是 `_`，此时"还有没有后续字节"与"还有没有后续码元"同真同假。
 * 判据在 `frontend/tests/asset-name.test.mjs`。
 *
 * 传进来的是整条 URL（调用方别自己先切），这里只取最后一段路径：
 * 带不带 CDN 域名、带不带 query 都能拿到同一个名字。
 */
export function assetDisplayName(url?: string): string {
    if (!url) {
        return '';
    }

    // 先切掉 query / hash（`/api/protect/download/a.png?x=1`），再取最后一段路径
    const path = url.split(/[?#]/)[0];
    const name = path.slice(path.lastIndexOf('/') + 1);

    // 14 位数字 + `_` + 至少一个字符
    return name.length > 15 && name[14] === '_' && /^\d{14}$/.test(name.slice(0, 14))
        ? name.slice(15)
        : name;
}
