/**
 * 图库 R2 图床的**纯映射**（20261006，用户第 3 条）：GB↔字节、用量百分比、
 * 「还能不能传」。抽出来只有一个目的 —— 这些数能进 `*.test.mjs` 直接跑，
 * 不必把整页 React 拖进沙箱。
 *
 * ## 为什么这些判定要单独成一处
 *
 * 面板上那条用量条与灰掉的按钮，是用户对"会不会产生账单"这件事的**唯一可见面**。
 * 它们只要和真正拦人的那条判据分家，就会出现"条子显示 30%、上传却被拒"这种
 * 没人能解释的状态。所以这里全是纯函数、没有一处读 React state。
 *
 * ## 跨语言契约（改一侧必须同步另一侧）
 *
 * · 配额单位：`quotaGB` 名义上叫 GB，实际口径是 **GiB**（1024³）—— 与 Rust
 *   `src/r2.rs::DEFAULT_QUOTA_GB` 那侧一致（`gib()` 用的就是 1024³）。
 *   面板显示的数字因此会略小于云厂商按十进制 GB 报的数（9.5 GiB ≈ 10.2 GB），
 *   这是**沿用服务端的尺子**、不是这里算错。
 * · 超限判据：`isOverQuota` 与 Rust `quota_exceeded`（`used + incoming > limit`，
 *   **严格大于**）是同一条。服务端判的是"加进这一张之后会不会超"，前端在**事前**
 *   没有这张图的大小（拖进来才知道），所以这边退一格判"已经贴到上限"：
 *   `used >= limit` ⇒ 任何一张非空文件都必然被服务端拒（文件至少 1 字节），
 *   灰掉它是诚实的。条子上的百分比与按钮的灰态因此总是一致的。
 * · 读数失败：`listError` 非空**绝不许**当成"用量是 0"（那会把读不到读成很空，
 *   是本仓反复踩过的那类坑）。`uploadBlocked` 在那种情况下直接判"传不了"。
 */

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
