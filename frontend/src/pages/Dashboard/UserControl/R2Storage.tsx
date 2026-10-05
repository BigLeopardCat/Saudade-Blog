import { useEffect, useState } from 'react'
import { Alert, Button, Input, InputNumber, Progress, Space, Switch, message } from 'antd'
import http from '../../../apis/axios.tsx'
import { getR2Usage } from '../../../apis/ImageMethods.tsx'
import type { R2Usage } from '../../../interface/Setting.d'
import { DEFAULT_QUOTA_GB, usagePercent, usageText } from '../../../utils/r2Quota'

/**
 * 「图库存储」页签（20261006，用户第 3 条：图库图片可以传到 R2 桶，但**严格控量**，
 * 超过 9.5G 就停用上传，防止产生账单）。
 *
 * ## 为什么配置住在这里
 *
 * 用户 20261006 拍板「挪到站点设置，单一入口」：这一页本来就是"站点自己的东西怎么配"
 * 的去处（见 index.tsx 头注），而**一个字段只有一处入口**是本仓付过学费的一条纪律
 * ——同一份数据挂两个表单，迟早各改各的。图库那边因此只留用量与灰态，不再有表单。
 *
 * ## 凭据不在这里 —— 这一条不是洁癖，是接口形状决定的
 *
 * `R2_ENDPOINT` / `R2_ACCESS_KEY` / `R2_SECRET_KEY` 只从服务端 `.env` 读
 * （`src/r2.rs::load_creds`），**永远不经这个接口**：`GET /api/protected/websetting`
 * 会把 `web_info` 的每一行**明文回传**给面板（`openAiToken`/`githubToken` 当年被删掉
 * 就是这个理由），而那道门是 `authz::can_access_console`（**admin ‖ superadmin**）。
 * 也就是说「站点设置只有超管能打开」在今天并不成立 —— 藏在这一页提供不了任何保护。
 * 桶名/前缀/公开域名不算凭据：知道桶名也写不进任何东西。
 *
 * ## 判定一律走 `utils/r2Quota.ts`
 *
 * 这条用量条的百分比与图库那颗上传按钮的灰态必须同源。这里**不许**自己再写一份
 * "超没超"的判据——分家的表现是"条子显示 30%、上传却被拒"，没人能解释。
 */

/** 表单草稿。读的是服务端**存着的**值，不是生效值（生效值在 `/api/protect/images/r2`）。 */
interface R2Form {
    enabled: boolean;
    bucket: string;
    prefix: string;
    publicBase: string;
    quotaGB: number | null;
}

const EMPTY: R2Form = {
    enabled: false,
    bucket: '',
    prefix: '',
    publicBase: '',
    quotaGB: DEFAULT_QUOTA_GB,
};

const R2Storage = () => {
    const [form, setForm] = useState<R2Form>(EMPTY);
    const [usage, setUsage] = useState<R2Usage | null>(null);
    const [saving, setSaving] = useState(false);

    /** 拉一次用量读数。**失败不清空已有读数**（清空会让条子跳回"读取中"，下一次成功
     *  又跳回来——用旧值比用空白诚实，`listError` 会说明它只是暂不可信）。 */
    const loadUsage = async (opts?: { silent?: boolean }) => {
        try {
            const res = await getR2Usage();
            if (res.data?.code === 200) {
                setUsage(res.data.data);
            } else if (!opts?.silent) {
                message.error(res.data?.message || '读取 R2 用量失败');
            }
        } catch {
            if (!opts?.silent) message.error('读取 R2 用量失败');
        }
    };

    /** 拉服务端存着的那五个键。配额不是正数/不是数字时按默认 9.5 显示 —— 与
     *  `r2::parse_config` 的回落口径一致（那一侧遇到同样的值也是按 9.5 生效的）。 */
    const loadForm = async () => {
        try {
            const res = await http.get('/api/protected/websetting');
            const d = res?.data?.data;
            if (!d) return;
            setForm({
                enabled: !!d.r2ImageEnabled,
                bucket: d.r2ImageBucket || '',
                prefix: d.r2ImagePrefix || '',
                publicBase: d.r2ImagePublicBase || '',
                quotaGB: typeof d.r2ImageQuotaGB === 'number' && d.r2ImageQuotaGB > 0
                    ? d.r2ImageQuotaGB
                    : DEFAULT_QUOTA_GB,
            });
        } catch {
            message.error('读取 R2 设置失败');
        }
    };

    // 只跑一次（本页其余页签同形）：两个 load 都自带错误提示，放别的依赖只会让它在
    // 打字时反复重拉。⚠️ 这里**不加 `eslint-disable`** —— 本仓没开 `exhaustive-deps`，
    // 写了反而是一条"多余的 disable"，而那条 lint 错误就是 CI 的质量闸（会红）。
    useEffect(() => {
        loadForm();
        loadUsage({ silent: true });
    }, []);

    /** 保存：**只提交这五个键**。接口语义是"只写请求里带了的那些"，顺手带上别的字段
     *  就会连带改写它们（本页其它页签同理）。业务码 200 才算成功。 */
    const save = async () => {
        if (form.quotaGB === null || !(form.quotaGB > 0)) {
            message.error('配额要填一个大于 0 的数字（单位 GB）');
            return;
        }
        setSaving(true);
        try {
            const res = await http.post('/api/protected/websetting', {
                r2ImageEnabled: form.enabled,
                r2ImageBucket: form.bucket,
                r2ImagePrefix: form.prefix,
                r2ImagePublicBase: form.publicBase,
                r2ImageQuotaGB: form.quotaGB,
            });
            if (res.data?.code === 200) {
                message.success('图库存储设置已保存');
                await loadForm();
                await loadUsage({ silent: true });
            } else {
                // 域名格式不对、配额不是正数时后端会整笔拒绝（`update_web_info`）——
                // 原因必须原样显示，否则用户只会看到"保存了但没生效"
                message.error(res.data?.message || '保存失败');
            }
        } catch {
            message.error('保存失败');
        } finally {
            setSaving(false);
        }
    };

    // 派生量（判据住在 utils/r2Quota.ts 一处）
    const text = usageText(usage);
    // 读数不可信时**不画百分比**：`usagePercent` 对 limit<=0 返回 100，那是"算不出来"
    // 的表达，印在条子上的 "100%" 会变成一句假话
    const pct = usage && !usage.listError ? usagePercent(usage.usedBytes, usage.limitBytes) : null;

    return (
        <div className='r2_storage'>
            <div style={{ marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <span style={{ fontSize: 13, color: text.ok ? 'inherit' : '#999' }}>{text.text}</span>
                    <Button size="small" onClick={() => loadUsage()}>刷新用量</Button>
                </div>
                <Progress
                    percent={pct === null ? 0 : pct}
                    status={pct === null ? 'normal' : (pct >= 100 ? 'exception' : 'active')}
                    strokeColor={pct === null ? '#bfbfbf' : undefined}
                    showInfo={false}
                />
                {/* 凭据来源（20261006 晚）。R2 令牌**按桶授权**：拿部署那枚去列图片桶
                    会得 403 AccessDenied，而那个症状与"代码写错了"长得一模一样 ——
                    这行是分辨它俩最快的判据（服务端只报来源，不含任何密钥）。 */}
                <span style={{ fontSize: 12, color: text.ok ? '#999' : '#c88' }}>
                    凭据来源：{usage?.credsSource || '未配置（图库走本机磁盘）'}
                </span>
            </div>

            <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Switch
                        checked={form.enabled}
                        onChange={(v) => setForm({ ...form, enabled: v })}
                    />
                    <span>启用 R2 图床（关闭时图片存本机磁盘）</span>
                </div>

                <Input
                    addonBefore="桶名"
                    placeholder="图库专用的 R2 桶（别用部署桶）"
                    value={form.bucket}
                    onChange={(e) => setForm({ ...form, bucket: e.target.value })}
                />
                <Input
                    addonBefore="前缀"
                    placeholder="gallery（对象键的命名空间，两端斜杠会自动去掉）"
                    value={form.prefix}
                    onChange={(e) => setForm({ ...form, prefix: e.target.value })}
                />
                <Input
                    addonBefore="公开域名"
                    placeholder="https://img.example.com（桶要开公开读）"
                    value={form.publicBase}
                    onChange={(e) => setForm({ ...form, publicBase: e.target.value })}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ whiteSpace: 'nowrap' }}>配额</span>
                    <InputNumber
                        min={0.1}
                        step={0.5}
                        style={{ width: 140 }}
                        value={form.quotaGB}
                        onChange={(v) => setForm({ ...form, quotaGB: v as number | null })}
                    />
                    <span>GB（超过就拒绝上传，防止产生账单）</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button type="primary" loading={saving} onClick={save} style={{ width: 100 }}>保存</Button>
                </div>

                <Alert
                    type="warning"
                    showIcon
                    message="换公开域名会让存量图片全部失效"
                    description="图库里存的是完整地址。域名一改，已上传的图就会 404，而且删不掉（系统认不出它们属于哪个桶）—— 想换域名请先想清楚存量图怎么办。"
                />
                <Alert
                    type="info"
                    showIcon
                    message="凭据不在这里填"
                    description="服务端 .env 里的 R2_ENDPOINT / R2_ACCESS_KEY / R2_SECRET_KEY 才是凭据；这里只存桶名、前缀、域名、配额与开关。桶要先在 Cloudflare 那边开好「公开读」，并把桶加进那枚 Access Key 的范围里。"
                />
            </Space>
        </div>
    );
};

export default R2Storage;
