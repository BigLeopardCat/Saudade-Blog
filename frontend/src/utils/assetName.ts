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
