/** 与 Rust `r2::DEFAULT_QUOTA_GB` 同值。**只在这里写一次**，页面不许再抄一个字面量。 */
export const DEFAULT_QUOTA_GB = 9.5;

const GIB = 1024 * 1024 * 1024;

/** 与 Rust `R2Usage` 同形（`/api/protect/images/r2` 的 `data`）。 */
export interface R2UsageLike {
    enabled: boolean;
    configured: boolean;
    credentials: boolean;
    bucket: string;
    prefix: string;
    publicBase: string;
    quotaGB: number;
    limitBytes: number;
    usedBytes: number;
    /** 为什么没有可信读数（未启用 / 没配全 / 没凭据 / 列表失败）。`null`/缺省才代表读数可信。 */
    listError?: string | null;
}

export function gibToBytes(gb: number): number {
    return Math.round(gb * GIB);
}

export function bytesToGib(bytes: number): number {
    return bytes / GIB;
}

/** 给人看的体积串（GiB 口径，与配额同一把尺子）。 */
export function formatGib(bytes: number): string {
    return `${bytesToGib(Math.max(0, bytes)).toFixed(2)} GB`;
}

/**
 * 用量条百分比，恒在 0..100 之间（antd Progress 收到超出的值只会画怪）。
 * `limitBytes <= 0` ⇒ 100：配额没配出个正数时，条子**不许**显示成"很空"。
 */
export function usagePercent(usedBytes: number, limitBytes: number): number {
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
        return 100;
    }
    const pct = (Math.max(0, usedBytes) / limitBytes) * 100;
    return Math.min(100, Math.max(0, Number(pct.toFixed(1))));
}

/**
 * 已经贴到上限（等价于"下一张会被服务端拒"）。判据见文件头注：这边用 `>=`、
 * 服务端用 `+ incoming > limit`，两者在"任何真实文件都 ≥ 1 字节"的前提下同真同假。
 */
export function isOverQuota(usedBytes: number, limitBytes: number): boolean {
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
        return true;
    }
    return usedBytes >= limitBytes;
}

/** 用量条要显示的那一行字。读数不可信时**只显示原因**，绝不显示数字。 */
export function usageText(usage?: R2UsageLike | null): { text: string; ok: boolean } {
    if (!usage) {
        return { text: '用量读取中…', ok: false };
    }
    if (usage.listError) {
        return { text: usage.listError, ok: false };
    }
    const used = formatGib(usage.usedBytes);
    const limit = formatGib(usage.limitBytes);
    return { text: `已用 ${used} / 上限 ${limit}（${usagePercent(usage.usedBytes, usage.limitBytes)}%）`, ok: true };
}

/**
 * 上传按钮该不该灰。返回原因串是要显示给人看的 —— "按钮不能点但没有理由"
 * 是本仓最容易被当成 bug 报的那类界面。
 */
export function uploadBlocked(usage?: R2UsageLike | null): { blocked: boolean; reason: string } {
    // 还没拉到读数：**不灰**。上传能不能成功由服务端说了算，界面不该抢在数据前面
    // 拦人（拉取失败的常见原因是页面刚打开，一秒钟后就正常了）。
    if (!usage || !usage.configured) {
        return { blocked: false, reason: '' };
    }
    if (usage.listError) {
        return { blocked: true, reason: `R2 用量读不出来，暂时不能上传：${usage.listError}` };
    }
    if (isOverQuota(usage.usedBytes, usage.limitBytes)) {
        return {
            blocked: true,
            reason: `R2 已用满（${formatGib(usage.usedBytes)} / ${formatGib(usage.limitBytes)}），请先清理或调高配额`,
        };
    }
    return { blocked: false, reason: '' };
}
