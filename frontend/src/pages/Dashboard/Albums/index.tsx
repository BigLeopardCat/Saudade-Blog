import InfiniteScroll from 'react-infinite-scroll-component';
import './index.sass'
import {Button, Card, Modal, Segmented, UploadFile} from "antd";
import DeleteButton from "../../../components/Buttons/DeleteButton";
import UpLoadButton from "../../../components/Buttons/UpLoadButton";
import {useCallback, useEffect, useState} from "react";
import { AppstoreOutlined, InboxOutlined, UnorderedListOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { message, Upload } from 'antd';
import CheckButton from "../../../components/Buttons/CheckButton";
import {ImgUrl} from "../../../interface/ImgTypes";
import {delImages, getImageList, getR2Usage, uploadImages} from "../../../apis/ImageMethods.tsx";
import type {UploadTarget} from "../../../apis/ImageMethods.tsx";
import ImageCompression from "../../../apis/ImageCompression.tsx";
import { resolveApiAssetUrl } from '../../../utils/runtimeApi';
import { assetDisplayName } from '../../../utils/assetName';
import type {R2Usage} from "../../../interface/Setting.d";
import {usagePercent, uploadBlocked} from "../../../utils/r2Quota";
import {useNavigate} from "react-router-dom";


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
    //
    // **配置不在这里**（20261006 用户拍板「挪到站点设置，单一入口」）：桶名/前缀/公开域名/
    // 配额/开关四个半字段都搬到 `#/dashboard/usercontrol` 的「图库存储」页签，本页只留
    // 「用量多少」与「现在能不能传」这两件跟"防账单"直接相关的事，以及一个跳过去的入口。
    // 本页因此**一个 R2 配置键都不该出现**（`frontend/tests/r2-quota.test.mjs` 钉着这条，
    // 连注释里写一遍它也会红——这条守卫是要"想加回表单"的人先撞一次墙）。
    const navigate = useNavigate();
    const [r2, setR2] = useState<R2Usage | null>(null);

    // ── 这次上传存哪儿（20261006，用户第 1 条：两颗按钮分别上传）──────────────
    // 起因：图库切到 R2 之后，那颗**唯一**的上传钮被 `uploadBlocked()` 灰掉了
    // （配额满、或用量读不出来——而读不出来正是令牌没配好时的常态），
    // 于是"存本机盘"这条明明还好的路**点不动了**。服务端那头当时也没有入口：
    // `try_r2_upload` 在面板开着 R2 时永不返回 `None`（静默改道，不报错）。
    // 现在两颗钮各带一个显式 target，服务端按它办。
    const [uploadTarget, setUploadTarget] = useState<UploadTarget>('local');

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

    /** 去站点设置的「图库存储」页签改配置。`{tab:'4'}` 让它直接落在那一页
     *  （见 `UserControl/index.tsx` 的 `initialTab`），否则用户点完还得自己找页签。 */
    const goR2Settings = () => {
        navigate('/dashboard/usercontrol', { state: { tab: '4' } });
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
    //上传悬浮框（`target` 决定这次传到哪儿，弹窗标题与提示都跟着它变）
    const showModal = (target: UploadTarget) => {
        setUploadTarget(target);
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
            // 显式 target：**这次点的是哪颗钮，就传到哪儿**（不再由面板开关替用户决定）
            uploadImages(formData, uploadTarget).then((res) => {
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
    // 读数不可信时**不显示百分比**（`usagePercent` 对 limit<=0 返回的是 100 ——
    // 那是"算不出来"的表达，印在按钮上会变成一句假话："R2 存储 · 100%"）
    const r2Pct = r2 && !r2.listError ? usagePercent(r2.usedBytes, r2.limitBytes) : null;
    // R2 那颗钮能不能点。**两种原因分开关**：没配全（去配置）与配额/读数（去清理）。
    // 顺序不能反：没配全时 `uploadBlocked` 按契约是"不拦"（它只管配额那件事），
    // 只有这里才知道"压根没启用"。
    const r2Disabled = !r2Configured || r2Blocked.blocked;
    const r2DisabledReason = !r2Configured
        ? '图库没启用 R2 图床（去「站点设置 → 图库存储」配置）'
        : r2Blocked.reason;


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
                    {/* ① 存本站服务器：**永不被 R2 的状态灰掉** —— 这正是本轮要修的那件事。
                        R2 开着、用量又读不出来的时候，本机盘这条路明明是好的，
                        从前那颗唯一的按钮却会被灰掉，于是整页一个能传的地方都没有。 */}
                    <UpLoadButton
                        onClick={() => showModal('local')}
                        label="传到本站"
                        title="上传到本站服务器（文件存在这台机器上）"
                    />
                    {/* ② 存 R2 图床：没配全 / 配额满 / 读数不可信时灰掉（判据同源于 utils/r2Quota） */}
                    <UpLoadButton
                        onClick={() => showModal('r2')}
                        label="传到 R2"
                        tone="alt"
                        disabled={r2Disabled}
                        title={r2DisabledReason || '上传到 R2 图床（文件存在对象存储上）'}
                    />
                    {/* 不能点就必须说出为什么（只藏在 title 里，触屏上根本看不到）。
                        这一行只跟 R2 那颗走 —— 服务器那颗永远能点，没有理由要说。
                        平时它不占位、不改变工具栏几何。 */}
                    {r2Disabled && (
                        <span
                            className="albumR2Blocked"
                            style={{color: 'var(--washi-pink-deep, #d94f9a)', fontSize: 13, maxWidth: 260}}
                        >
                            {r2DisabledReason}
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
                    {/* R2 图床（20261006）：这颗按钮**只报用量 + 跳去配置**（配置本身在
                        站点设置的「图库存储」页签）。它同时是这一页唯一的"会不会产生账单"
                        的常驻读数——灰态与拦人的那条判据同源（`utils/r2Quota.ts`）。 */}
                    <Button
                        onClick={goR2Settings}
                        title={r2Configured ? 'R2 图床用量（点开改配置）' : 'R2 图床未启用，当前存本机磁盘（点开可配置）'}
                    >
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
            {/* `albumScrollCard` 只给窄屏那条媒体规则当抓手：`height:86vh` + 内滚动写在内联上，
                普通 CSS 声明够不着它（内联优先级最高），窄屏只能用 `!important` 翻过来。 */}
            <Card className="albumScrollCard" style={{ width: '100%', height: '86vh', marginLeft: '0%', marginTop: '0%', overflowY: 'scroll', backgroundColor: 'transparent', border: "none" }}>
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
                   title={uploadTarget === 'r2' ? '上传到 R2 图床' : '上传到本站服务器'}
            >
                <Dragger {...props} listType='picture'>
                    <p className="ant-upload-drag-icon">
                        <InboxOutlined />
                    </p>
                    <p className="ant-upload-text">点击或拖动文件到此区域进行上传</p>
                    <p className="ant-upload-hint">
                        支持单个或批量上传
                    </p>
                    {/* 两档的差异必须写在弹窗里：拖进去的图是落到本机盘还是进桶，
                        决定了它以后"搬机器/换域名会不会失效"，而这一眼看得出来最省事。 */}
                    <p className="ant-upload-hint">
                        {uploadTarget === 'r2'
                            ? `这次传到 R2 图床${r2?.publicBase ? `（公开域 ${r2.publicBase}）` : ''}，不占本机磁盘。`
                            : '这次传到本站服务器（存在这台机器的磁盘上），地址是站内相对路径。'}
                    </p>
                </Dragger>


            </Modal>
    </InfiniteScroll>

        <Modal title="删除确认" open={isModaldelOpen} onOk={handledelOk} onCancel={handledelCancel}  okText="确定" cancelText="取消">
            是否删除选中所有图片?
        </Modal>

        {/* R2 的设置弹窗 20261006 搬到站点设置（`UserControl/R2Storage.tsx`）：
            那颗「R2 存储 · N%」按钮改成那边的一个入口，本页只留用量与灰态。
            同一个字段两个表单，是"改了一处、另一处还是旧值"的经典来源。 */}
    </div>
}

export default Albums