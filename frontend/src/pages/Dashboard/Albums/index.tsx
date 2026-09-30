import InfiniteScroll from 'react-infinite-scroll-component';
import './index.sass'
import { Card, Modal, Segmented, UploadFile} from "antd";
import DeleteButton from "../../../components/Buttons/DeleteButton";
import UpLoadButton from "../../../components/Buttons/UpLoadButton";
import {useCallback, useEffect, useState} from "react";
import { AppstoreOutlined, InboxOutlined, UnorderedListOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { message, Upload } from 'antd';
import CheckButton from "../../../components/Buttons/CheckButton";
import {ImgUrl} from "../../../interface/ImgTypes";
import {delImages, getImageList, uploadImages} from "../../../apis/ImageMethods.tsx";
import ImageCompression from "../../../apis/ImageCompression.tsx";
import { resolveApiAssetUrl } from '../../../utils/runtimeApi';
import { assetDisplayName } from '../../../utils/assetName';


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
    },[])


    // 获取图片列表
    const initImageList = () => {
        getImageList().then((res) => {
            setStaticDate(res.data.data)
        }).catch((error) => {
            throw error
        })
    }

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
                if (res.status === 200) {
                    initImageList();
                    // @ts-ignore
                    message.success(`${req.file.name} 图片上传成功`);
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
                <UpLoadButton onClick={showModal} />
                <div style={{ display: "flex", flexDirection: 'row', alignItems: 'center' }}>
                    <h2 style={{display: "flex", flexDirection: 'row', alignItems: 'center'}}> <i className="iconfont icon-xiangce icon" style={{ fontWeight: '80', fontSize: 50, color: 'var(--washi-lav, #b9a7f5)' }} /> 图库  </h2>
                </div>
                <div className={"albumActions"} style={{display: "flex",alignItems:'center'}}>
                    {/* 「已选中 N 张」原来绝对定位在 right:180 —— 现在它是流内的一员
                        （`opacity` 到 0 时**照旧占位**，切换器与删除钮不会因为选没选中而左右跳） */}
                    <h2 className={"albumSelCount"} style={{opacity: SelectDelete !== 0 ? 1 : 0, transition: '0.3s'}}>已选中{SelectDelete}张图片</h2>
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
    </div>
}

export default Albums