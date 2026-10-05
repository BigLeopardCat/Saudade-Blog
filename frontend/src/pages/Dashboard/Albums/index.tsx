import InfiniteScroll from 'react-infinite-scroll-component';
import './index.sass'
import {Alert, Button, Card, Input, InputNumber, Modal, Progress, Segmented, Space, Switch, UploadFile} from "antd";
import DeleteButton from "../../../components/Buttons/DeleteButton";
import UpLoadButton from "../../../components/Buttons/UpLoadButton";
import {useCallback, useEffect, useState} from "react";
import { AppstoreOutlined, InboxOutlined, UnorderedListOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { message, Upload } from 'antd';
import CheckButton from "../../../components/Buttons/CheckButton";
import {ImgUrl} from "../../../interface/ImgTypes";
import {delImages, getImageList, getR2Usage, uploadImages} from "../../../apis/ImageMethods.tsx";
import http from "../../../apis/axios.tsx";
import ImageCompression from "../../../apis/ImageCompression.tsx";
import { resolveApiAssetUrl } from '../../../utils/runtimeApi';
import { assetDisplayName } from '../../../utils/assetName';
import type {R2Usage} from "../../../interface/Setting.d";
import {DEFAULT_QUOTA_GB, usagePercent, uploadBlocked, usageText} from "../../../utils/r2Quota";


/** 图库的两种展示方式（用户要求：一种当前的直接展开，一种列表——行首缩略图 + 图片名）。 */
type AlbumView = 'grid' | 'list';

/** 上次选的那一种。读了就记住（与站内其它 localStorage 键一样整体包 try：
 *  Safari 无痕下 `localStorage` 本身就可能抛）。 */
const ALBUM_VIEW_KEY = 'albumViewMode';

const Albums = () => {
    //状态变量区
    const [uploadedFiles, setUploadedFiles] = useState<UploadFile[]>([]);
    const [SelectDelete,setSelectDelete] = useState(0)
    const [checkStatus, setCheckStatus] = useState<Record<string, boolean>>({});
    const [staticDate, setStaticDate] = useState<ImgUrl[]>([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isModaldelOpen, setIsDelModalOpen] = useState(false);
    const [view, setView] = useState<AlbumView>(() => {
        try {
            return localStorage.getItem(ALBUM_VIEW_KEY) === 'list' ? 'list' : 'grid';
        } catch {
            return 'grid';
        }
    });

    // ── R2 图床（20261006，用户第 3 条）────────────────────────────────────
    // 用量是**服务端从 R2 自己列出来的**（不是本页算的），所以每次上传/删除完都要重拉：
    // 这一页显示的数字与真正拦人的那条判据必须同源，否则会出现"条子 30% 却被拒"。
    const [r2, setR2] = useState<R2Usage | null>(null);
    const [r2Open, setR2Open] = useState(false);
    const [r2Saving, setR2Saving] = useState(false);
    /** 弹窗里的草稿（**读的是服务端存的值**，不是生效值——见弹窗里的提示语） */
    const [r2Form, setR2Form] = useState({
        enabled: false,
        bucket: '',
        prefix: '',
        publicBase: '',
        quotaGB: DEFAULT_QUOTA_GB as number | null,
    });

    const changeView = (v: AlbumView) => {
        setView(v);
        try {
            localStorage.setItem(ALBUM_VIEW_KEY, v);
        } catch {
            // 存不下就只当次生效——切展示方式这种偏好不值得弹窗打扰
        }
    };


    useEffect(() => {
        initImageList()
        loadR2()
    },[])


    // 获取图片列表
    const initImageList = () => {
        getImageList().then((res) => {
            setStaticDate(res.data.data)
        }).catch((error) => {
            throw error
        })
    }

    // ── R2 用量 ────────────────────────────────────────────────────────────
    /** 拉一次用量读数。**失败不清空已有读数**（清空会让条子跳回"读取中"，
     *  而下一次成功时又跳回来——用旧值比用空白诚实，`listError` 会说明它只是暂不可信）。 */
    const loadR2 = async (opts?: { silent?: boolean }) => {
        try {
            const res = await getR2Usage();
            if (res.data?.code === 200) {
                setR2(res.data.data);
            } else if (!opts?.silent) {
                message.error(res.data?.message || '读取 R2 用量失败');
            }
        } catch {
            if (!opts?.silent) message.error('读取 R2 用量失败');
        }
    };

    /** 打开设置弹窗：**表单取服务端存的那五个键**（与用量的生效值分开——
     *  生效值在 `/api/protect/images/r2`，存的值在 `/api/protected/websetting`）。 */
    const openR2 = async () => {
        setR2Open(true);
        loadR2({ silent: true });
        try {
            const res = await http.get('/api/protected/websetting');
            const d = res?.data?.data;
            if (d) {
                setR2Form({
                    enabled: !!d.r2ImageEnabled,
                    bucket: d.r2ImageBucket || '',
                    prefix: d.r2ImagePrefix || '',
                    publicBase: d.r2ImagePublicBase || '',
                    quotaGB: typeof d.r2ImageQuotaGB === 'number' && d.r2ImageQuotaGB > 0
                        ? d.r2ImageQuotaGB
                        : DEFAULT_QUOTA_GB,
                });
            }
        } catch {
            message.error('读取 R2 设置失败');
        }
    };

    /** 保存：**只提交这五个键**（接口语义是"只写请求里带了的那些"，
     *  顺手带上别的字段就会连带改写它们）。业务码 200 才算成功。 */
    const saveR2 = async () => {
        if (r2Form.quotaGB === null || !(r2Form.quotaGB > 0)) {
            message.error('配额要填一个大于 0 的数字（单位 GB）');
            return;
        }
        setR2Saving(true);
        try {
            const res = await http.post('/api/protected/websetting', {
                r2ImageEnabled: r2Form.enabled,
                r2ImageBucket: r2Form.bucket,
                r2ImagePrefix: r2Form.prefix,
                r2ImagePublicBase: r2Form.publicBase,
                r2ImageQuotaGB: r2Form.quotaGB,
            });
            if (res.data?.code === 200) {
                message.success('R2 设置已保存');
                setR2Open(false);
                loadR2({ silent: true });
            } else {
                // 域名格式不对、配额不是正数时后端会整笔拒绝（见 update_web_info）——
                // 原因必须原样显示，否则用户只会看到"保存了但没生效"
                message.error(res.data?.message || '保存失败');
            }
        } catch {
            message.error('保存失败');
        } finally {
            setR2Saving(false);
        }
    };

    //回调函数区域
    const fetchData = async () => {

    };

    const Delete = useCallback(() => {
        // @ts-ignore
        //拿出所有的键
        const keysToDelete = Object.keys(checkStatus).filter(key => checkStatus[key]);

        delImages(keysToDelete).then((res) => {
            // 20260924：后端现在会**整体拒绝**还在被文章使用的图（本仓契约是 HTTP 200 + code 500），
            // 只看 res.status 会把"一张都没删"显示成"删除成功" ⇒ 改判业务码并如实报出原因
            if (res.data?.code === 200) {
                initImageList()
                loadR2({ silent: true });   // R2 上的对象没了 ⇒ 用量条要跟上
                message.success("删除成功");
            } else {
                message.error(res.data?.message || "删除失败：这些图片还有文章在用");
            }
            // 两种情况都清空勾选（留着勾选会让人以为"点了没生效"）
            setCheckStatus({});
            setSelectDelete(0);
        }).catch((error) => {
            message.error("删除失败：" + error)
            // 删除完毕后清空 checkStatus
            setCheckStatus({});
            setSelectDelete(0);
        })
    }, [SelectDelete, checkStatus]);

    // 触发选择框和图片点击
    const handleItemClick = (img: ImgUrl) => {
        // 检查当前图片对应的复选框状态
        const isChecked = checkStatus[img.imageUrl] || false;

        // 更新复选框状态
        setCheckStatus(prevState => ({
            ...prevState,
            [img.imageUrl]: !isChecked // 切换复选框状态
        }));

        // 更新选择的数量
        setSelectDelete(prevCount => isChecked ? prevCount - 1 : prevCount + 1);
    };
    //上传悬浮框
    const showModal = () => {
        setIsModalOpen(true);
    };

    const handleOk = () => {
        setUploadedFiles([])
        setIsModalOpen(false);
    };

    const handleCancel = () => {
        setUploadedFiles([])
        setIsModalOpen(false);
    };

    //推拽上传
    const { Dragger } = Upload;
    const props: UploadProps = {
        name: 'file',
        fileList: uploadedFiles,
        multiple: true,
        customRequest: async (req) => {
            // @ts-ignore
            const compressedFile = await ImageCompression(req.file);
            const formData = new FormData();
            formData.append('file', compressedFile);
            uploadImages(formData).then((res) => {
                // ⚠️ 判**业务码**而不是 `res.status`（20261006 修）。本仓的失败一律是
                // HTTP 200 + `code: 500`（服务端从不靠状态码表达业务失败），所以原先那句
                // `res.status === 200` 恒真 —— 配额拒绝、R2 凭据缺失、PUT 失败**全都被
                // 显示成"上传成功"**，而图库里什么都不会多出来。用户要防的正是配额那件事，
                // 这类"假成功"会让它看起来像功能坏了。
                if (res.data?.code === 200) {
                    initImageList();
                    // @ts-ignore antd 的 req.file 是 `string | RcFile`，取名字要窄化
                    const uploadedName: string = req.file.name;
                    // 服务端给了话就以它为准（HEAD 命中复用时会说"已存在，已复用"）
                    message.success(res.data?.message && res.data.message !== 'ok'
                        ? `${uploadedName}：${res.data.message}`
                        : `${uploadedName} 图片上传成功`);
                    loadR2({ silent: true });   // 用量变了，条子要跟上
                } else {
                    message.error(res.data?.message || '上传失败');
                }
            }).catch((error) => {
                message.error('上传失败' + error);
            });

        },
        onDrop(e) {
            console.log('Dropped files', e.dataTransfer.files);
        },
        progress: {
            strokeColor: {
                '0%': '#108ee9',
                '100%': '#87d068',
            },
            strokeWidth: 3,
            format: (percent) => percent && `${parseFloat(percent.toFixed(2))}%`,
        },
    };

    const showdelModal = () => {
        if(SelectDelete === 0){
            message.warning("待选中")
            return
        }else {
            setIsDelModalOpen(true);
        }
    };

    const handledelOk = () => {
        Delete()
        setIsDelModalOpen(false);
    };

    const handledelCancel = () => {
        setIsDelModalOpen(false);
    };

    // 派生量（全是纯函数，判据住在 `utils/r2Quota.ts` 一处）
    const r2Blocked = uploadBlocked(r2);
    const r2Configured = !!r2?.configured;
    const r2Usage = usageText(r2);
    // 读数不可信时**不显示百分比**（`usagePercent` 对 limit<=0 返回的是 100 ——
    // 那是"算不出来"的表达，印在按钮上会变成一句假话："R2 存储 · 100%"）
    const r2Pct = r2 && !r2.listError ? usagePercent(r2.usedBytes, r2.limitBytes) : null;


    return <div style={{height: '100%'}} className='allin'>
        <InfiniteScroll
        dataLength={staticDate.length}
        next={fetchData}
        hasMore={true}
        loader={null}
        endMessage={
            <p style={{ textAlign: 'center' }}>
                <b>Yay! You have seen it all</b>
            </p>
        }
    >
            <div style={{display: "flex",flexDirection: 'row',alignItems:'center',justifyContent: 'space-between',marginTop: 30,marginLeft: 20,marginRight: 20}} className={"action_img"}>
                <div style={{display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12}}>
                    <UpLoadButton onClick={showModal} disabled={r2Blocked.blocked} title={r2Blocked.reason || undefined} />
                    {/* 不能点就必须说出为什么（只藏在 title 里，触屏上根本看不到）。
                        这一行只在被拦时渲染 —— 平时它不占位、不改变工具栏几何。 */}
                    {r2Blocked.blocked && (
                        <span style={{color: 'var(--washi-pink-deep, #d94f9a)', fontSize: 13, maxWidth: 260}}>
                            {r2Blocked.reason}
                        </span>
                    )}
                </div>
                <div style={{ display: "flex", flexDirection: 'row', alignItems: 'center' }}>
                    <h2 style={{display: "flex", flexDirection: 'row', alignItems: 'center'}}> <i className="iconfont icon-xiangce icon" style={{ fontWeight: '80', fontSize: 50, color: 'var(--washi-lav, #b9a7f5)' }} /> 图库  </h2>
                </div>
                <div className={"albumActions"} style={{display: "flex",alignItems:'center'}}>
                    {/* 「已选中 N 张」原来绝对定位在 right:180 —— 现在它是流内的一员
                        （`opacity` 到 0 时**照旧占位**，切换器与删除钮不会因为选没选中而左右跳） */}
                    <h2 className={"albumSelCount"} style={{opacity: SelectDelete !== 0 ? 1 : 0, transition: '0.3s'}}>已选中{SelectDelete}张图片</h2>
                    {/* R2 图床设置（20261006）：桶名/前缀/公开域名/配额/开关。
                        用量条也在这个弹窗里 —— 它是后台唯一能看见"会不会产生账单"的地方 */}
                    <Button onClick={openR2} title={r2Configured ? 'R2 图床设置与用量' : 'R2 图床未启用，当前存本机磁盘'}>
                        {r2Pct === null ? 'R2 存储' : `R2 存储 · ${r2Pct}%`}
                    </Button>
                    <Segmented
                        value={view}
                        onChange={(v) => changeView(v as AlbumView)}
                        options={[
                            { value: 'grid', label: '平铺', icon: <AppstoreOutlined /> },
                            { value: 'list', label: '列表', icon: <UnorderedListOutlined /> },
                        ]}
                    />
                    <div onClick={showdelModal}>
                        <DeleteButton />
                    </div>
                </div>
            </div>
            <Card style={{ width: '100%', height: '86vh', marginLeft: '0%', marginTop: '0%', overflowY: 'scroll', backgroundColor: 'transparent', border: "none" }}>
                {view === 'list' ? (
                    <div className={"albumList"}>
                        {staticDate.map(item => {
                            const checked = checkStatus[item.imageUrl] || false;
                            // 展示名走 `utils/assetName.ts`（去掉上传时压的那串时间戳前缀，
                            // 与 Rust `strip_timestamp_prefix` 同一条规则）
                            const name = assetDisplayName(item.imageUrl);
                            return (
                                <div
                                    key={item.imageKey}
                                    className={`albumRow${checked ? ' is-checked' : ''}`}
                                    onClick={() => handleItemClick(item)}
                                >
                                    <img
                                        className={"albumThumb"}
                                        src={resolveApiAssetUrl(item.imageUrl)}
                                        alt={name}
                                        loading={"lazy"}
                                    />
                                    <span className={"albumName"} title={name}>{name}</span>
                                    {/* 勾选框自己也要能点：不拦冒泡的话这一下会被行接走再翻一次，
                                        净效果是"点勾选框没反应" */}
                                    <span className={"albumCheck"} onClick={(e) => e.stopPropagation()}>
                                        <CheckButton
                                            checked={checked}
                                            handleCheckBoxChange={() => handleItemClick(item)}
                                        />
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    staticDate.map(item => (
                        <div key={item.imageKey} style={{ position: 'relative', display: 'inline-block' }}>
                            <div style={{ position: 'absolute', top: 30, right: 40, transform: 'scale(0.8)',zIndex: 3 }}>
                                <CheckButton
                                    checked={checkStatus[item.imageUrl] || false}
                                    handleCheckBoxChange={() => handleItemClick(item)}
                                />
                            </div>
                            <img
                                src={resolveApiAssetUrl(item.imageUrl)}
                                onClick={() => handleItemClick(item)}
                                style={{ maxWidth: 250, maxHeight: 250, margin: 40, marginLeft: 45, marginTop: 30, borderRadius: 10 }}
                                className='imgShade'
                            />
                        </div>
                    ))
                )}
            </Card>

            <Modal
                   open={isModalOpen}
                   onOk={handleOk}
                   onCancel={handleCancel}
                   okText='完成'
                   cancelText='取消'
            >
                <Dragger {...props} listType='picture'>
                    <p className="ant-upload-drag-icon">
                        <InboxOutlined />
                    </p>
                    <p className="ant-upload-text">点击或拖动文件到此区域进行上传</p>
                    <p className="ant-upload-hint">
                        支持单个或批量上传
                    </p>
                </Dragger>


            </Modal>
    </InfiniteScroll>

        <Modal title="删除确认" open={isModaldelOpen} onOk={handledelOk} onCancel={handledelCancel}  okText="确定" cancelText="取消">
            是否删除选中所有图片?
        </Modal>

        {/* ── R2 图床设置（20261006，用户第 3 条）──────────────────────────────
            三块：开关 + 四个配置格（存 web_info）、用量条（读 R2 真实对象列表）、
            两条必须写明的代价。**凭据不在这里** —— 它们只从服务端 .env 读，
            这个接口会把收到的每一行明文回传，凭据绝不能过它。 */}
        <Modal
            title="R2 图床设置"
            open={r2Open}
            onOk={saveR2}
            onCancel={() => setR2Open(false)}
            okText="保存"
            cancelText="取消"
            confirmLoading={r2Saving}
            width={560}
        >
            <Space direction="vertical" size={12} style={{width: '100%'}}>
                <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                    <Switch
                        checked={r2Form.enabled}
                        onChange={(v) => setR2Form({...r2Form, enabled: v})}
                    />
                    <span>启用 R2 图床（关闭时图片存本机磁盘）</span>
                </div>

                <Input
                    addonBefore="桶名"
                    placeholder="图库专用的 R2 桶（别用部署桶）"
                    value={r2Form.bucket}
                    onChange={(e) => setR2Form({...r2Form, bucket: e.target.value})}
                />
                <Input
                    addonBefore="前缀"
                    placeholder="gallery（对象键的命名空间，两端斜杠会自动去掉）"
                    value={r2Form.prefix}
                    onChange={(e) => setR2Form({...r2Form, prefix: e.target.value})}
                />
                <Input
                    addonBefore="公开域名"
                    placeholder="https://img.example.com（桶要开公开读）"
                    value={r2Form.publicBase}
                    onChange={(e) => setR2Form({...r2Form, publicBase: e.target.value})}
                />
                <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                    <span style={{whiteSpace: 'nowrap'}}>配额</span>
                    <InputNumber
                        min={0.1}
                        step={0.5}
                        style={{width: 140}}
                        value={r2Form.quotaGB}
                        onChange={(v) => setR2Form({...r2Form, quotaGB: v as number | null})}
                    />
                    <span>GB（超过就拒绝上传，防止产生账单）</span>
                </div>

                <div>
                    <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4}}>
                        <span style={{fontSize: 13, color: r2Usage.ok ? 'inherit' : '#999'}}>{r2Usage.text}</span>
                        <Button size="small" onClick={() => loadR2()}>刷新用量</Button>
                    </div>
                    <Progress
                        percent={r2Pct === null ? 0 : r2Pct}
                        status={r2Pct === null ? 'normal' : (r2Pct >= 100 ? 'exception' : 'active')}
                        strokeColor={r2Pct === null ? '#bfbfbf' : undefined}
                        showInfo={false}
                    />
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
                    description="服务端 .env 里的 R2_ENDPOINT / R2_ACCESS_KEY / R2_SECRET_KEY 才是凭据；这个页面只存桶名、前缀、域名、配额与开关。桶要先在 Cloudflare 那边开好「公开读」。"
                />
            </Space>
        </Modal>
    </div>
}

export default Albums