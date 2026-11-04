import { Alert, Avatar, Badge, Button, ConfigProvider, Empty, Input, List, Modal, Tabs, Tag, message, theme as antdTheme } from 'antd'

import { quotaBalanceText, quotaLevel, quotaPct, quotaUsedHint } from '../../utils/quota.ts'
import { resolveApiAssetUrl } from '../../utils/runtimeApi'

import { Z } from '../../zIndex'
import {applyQuotaReset, errMsg, getMyQuota, ok} from "../../apis/ProfileMethods.tsx";

import AvatarCropModal from '../AvatarCropModal'
import StickerText from '../StickerText'
import { RoleBadge } from '../RoleBadge'
import { DEFAULT_AVATAR_URL } from './identity'

import './index.sass'
import {fmtMinute, TALK_STATUS, snippet} from "./format";
import {useUserCenterModel} from './useUserCenterModel';
import type {MessageItem, NotificationItem} from '../../interface/ProfileType';

interface UserCenterProps {
    open: boolean
    onClose: () => void
}

const UserCenter = ({open,onClose}: UserCenterProps) => {
    const {
        isDark, navigate, loggedIn, admin,
        uid, counts, tab, profile,
        effectiveRole, favorites, favFailed, talks,
        notices, noticeUnread, noticeOpenId, setNoticeOpenId,
        mailbox, quota, setQuota, applyOpen,
        setApplyOpen, applyReason, setApplyReason, applying,
        setApplying, loadingTab, cropFile, setCropFile,
        cropOpen, setCropOpen, uploading, nickname,
        setNickname, savingNick, pwdOld, setPwdOld,
        pwdNew, setPwdNew, pwdNew2, setPwdNew2,
        savingPwd, to, setTo, mailTitle,
        setMailTitle, body, setBody, sending,
        mailTab, opened, setOpened, drafts,
        savingDraft, editingDraftId, unreadOf, onTabChange,
        onMailTabChange, handlePickFile, handleCropConfirm, saveNickname,
        savePassword, dropFavorite, openArticle, removeNoticeButton,
        removeMailButton, markNoticesRead, openNotice, doSend,
        openMail, doSaveDraft, continueDraft, newMail,
        dropDraft, markMailRead, boardTalks, myAvatar,
    } = useUserCenterModel({open, onClose});
    const title = (
        <div className="ucTitle">
            <span className="ucTitleText">个人中心</span>
            {admin && (
                <Button
                    size="small"
                    type="link"
                    onClick={() => {
                        onClose()
                        navigate('/dashboard')
                    }}
                >
                    后台管理
                </Button>
            )}
        </div>
    )

    const settingsPane = (
        <div className="ucPane ucSettings">
            <div className="ucAvatarRow">
                <Avatar size={96} src={myAvatar} className="ucAvatar" />
                <div className="ucAvatarMeta">
                    <div className="ucAvatarName">
                        <span className="ucNickName">{profile?.nickname || profile?.username || ''}</span>
                        <RoleBadge
                            className="ucRoleTag"
                            role={effectiveRole}
                            size={24}
                            style={{ marginLeft: 8 }}
                        />
                    </div>
                    <div className="ucAvatarAccount">UID：{uid ?? '—'}</div>
                    <div className="ucAvatarAccount">账号：{profile?.username || ''}（账号不可修改）</div>
                    <label className="ucUploadBtn">
                        更换头像
                        <input
                            type="file"
                            accept="image/*"
                            onChange={(e) => {
                                const f = e.target.files?.[0]
                                e.target.value = ''
                                if (!f) return
                                if (!f.type.startsWith('image/')) {
                                    message.error('请选择图片文件')
                                    return
                                }
                                handlePickFile(f)
                            }}
                        />
                    </label>
                </div>
            </div>

            {profile?.nicknameAutoRenamed && (
                <Alert
                    className="ucNickBanner"
                    type="warning"
                    showIcon
                    message="你的昵称和其他用户重复了"
                    description={
                        <>为避免重名，系统已把它临时改成「{profile?.nickname || ''}」。
                            请在下面改成别的昵称，改完这条提示就消失。</>
                    }
                />
            )}

            {profile?.muted && (
                <Alert
                    className="ucMuteBanner"
                    type="warning"
                    showIcon
                    message="你暂时不能发布评论与留言"
                    description={
                        <>你的账号被临时禁言{profile?.mutedUntil ? `（${profile.mutedUntil}）` : ''}，
                            期间发出的评论与留言会被拒；其余一切照常——仍可登录、浏览文章、与泠月喵对话。
                            如有疑问请联系博主。</>
                    }
                />
            )}

            <div className="ucField">
                <span className="ucLabel">昵称</span>
                <Input
                    value={nickname}
                    maxLength={20}
                    showCount
                    placeholder="展示用昵称（留言、说说、信箱里显示这个）"
                    onChange={(e) => setNickname(e.target.value)}
                />
                <Button className="ucPrimaryBtn" type="primary" loading={savingNick} onClick={saveNickname}>
                    保存
                </Button>
            </div>

            {open && (
                <div className="ucField ucFieldStack">
                    <span className="ucLabel">修改密码</span>
                    <Input.Password
                        value={pwdOld}
                        placeholder="原密码"
                        autoComplete="current-password"
                        onChange={(e) => setPwdOld(e.target.value)}
                    />
                    <Input.Password
                        value={pwdNew}
                        placeholder="新密码（至少 8 位）"
                        autoComplete="new-password"
                        onChange={(e) => setPwdNew(e.target.value)}
                    />
                    <Input.Password
                        value={pwdNew2}
                        placeholder="再输一次新密码"
                        autoComplete="new-password"
                        onChange={(e) => setPwdNew2(e.target.value)}
                    />
                    <div className="ucFieldFoot">
                        <span className="ucHint">改密码会让其他设备立刻下线（本机保持登录）</span>
                        <Button className="ucPrimaryBtn" type="primary" loading={savingPwd} onClick={savePassword}>
                            修改密码
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )

    const favoritesPane = (
        <div className="ucPane">
            <List
                loading={favorites === null && !favFailed}
                dataSource={favorites || []}
                locale={{
                    emptyText: favFailed && favorites === null
                        // 读不到 ≠ 没有收藏（同一族谎，见 favorites.ts 的 failed）
                        ? <Empty description="收藏列表没读到（网络或登录状态问题），过一会儿再打开看看" />
                        : <Empty description="还没有收藏的文章（文章页点「收藏」）" />,
                }}
                renderItem={(item) => (
                    <List.Item
                        actions={[
                            <Button type="link" key="open" onClick={() => openArticle(item.noteId)}>
                                阅读
                            </Button>,
                            <Button type="link" danger key="del" onClick={() => dropFavorite(item.noteId)}>
                                取消收藏
                            </Button>,
                        ]}
                    >
                        <List.Item.Meta
                            title={
                                <a onClick={() => openArticle(item.noteId)} className="ucItemTitle">
                                    {item.title}
                                </a>
                            }
                            description={`收藏于 ${fmtMinute(item.createdAt)}`}
                        />
                    </List.Item>
                )}
            />
        </div>
    )

    const talksPane = (
        <div className="ucPane">
            <div className="ucPaneBar">
                <span className="ucHint">这里只列河灯留言（说说在「说说」页）</span>
            </div>
            <List
                loading={loadingTab && talks === null}
                dataSource={boardTalks}
                locale={{ emptyText: <Empty description="还没有留言记录" /> }}
                renderItem={(t) => {
                    const st = TALK_STATUS[t.approved] || { text: '未知', color: 'default' }
                    return (
                        <List.Item>
                            <List.Item.Meta
                                title={
                                    <span className="ucItemTitle">
                                        {t.cat && <span className="ucSeal" title="河灯留言的类型">{t.cat}</span>}
                                        {t.content ? t.content.slice(0, 24) : '（无标题）'}
                                        <Tag color={st.color}>{st.text}</Tag>
                                    </span>
                                }
                                description={
                                    <div className="ucBody">
                                        <div className="ucBodyText">{t.content}</div>
                                        {t.approved === 2 && (
                                            <div className="ucReject">
                                                驳回理由：{t.rejectReason || '未填写'}
                                            </div>
                                        )}
                                        <div className="ucBodyTime">{fmtMinute(t.createdAt)}</div>
                                    </div>
                                }
                            />
                        </List.Item>
                    )
                }}
            />
        </div>
    )

    /** 点开的那条通知：**现从 `notices` 里按 id 取**，不存整条快照。
     *
     *  与信箱那边（`opened`，刻意存快照）**不同**，是为了点完底部那颗「标记为已读」
     *  当场就是已读态——`markNoticesRead` 改的是列表那一份，取快照的话这里会停在
     *  "未读"上、按钮永远亮着。副作用是 agent-turn-done 重拉列表时这里也跟着更新
     *  （好事：那正是"窗口开着时 agent 刚发来一条"的场景）；万一这条在重拉后没了
     *  （比如被删），`find` 落空 ⇒ 自动退回列表，不会渲染一封幽灵信。 */
    const openedNotice =
        noticeOpenId == null ? null : (notices || []).find((n) => n.id === noticeOpenId) || null

    const noticeDetail = (n: NotificationItem) => (
        <div className="ucNoticeDetail">
            <div className="ucNoticeDetailBar">
                <Button size="small" onClick={() => setNoticeOpenId(null)}>
                    返回公告和通知
                </Button>
            </div>
            <div className="ucNoticeDetailHead">
                <Tag color={n.type === 'announcement' ? 'geekblue' : 'cyan'}>
                    {n.type === 'announcement' ? '公告' : '通知'}
                </Tag>
                <span className="ucNoticeWhen">{fmtMinute(n.createdAt)}</span>
            </div>
            <div className="ucNoticeDetailTitle">{n.title}</div>
            <div className="ucNoticeDetailBody">
                <StickerText text={n.content} />
            </div>
            <div className="ucNoticeDetailFoot">
                {n.link ? (
                    <Button className="ucGoBtn" onClick={() => openNotice(n)}>
                        去看看
                    </Button>
                ) : null}
                {n.isRead ? (
                    <span className="ucHint">已读</span>
                ) : (
                    <Button type="primary" onClick={() => markNoticesRead([n.id])}>
                        标记为已读
                    </Button>
                )}
                {removeNoticeButton(n.id)}
            </div>
        </div>
    )

    const noticesPane = openedNotice ? (
        <div className="ucPane">{noticeDetail(openedNotice)}</div>
    ) : (
        <div className="ucPane">
            <div className="ucPaneBar">
                <span className="ucHint">
                    公告在发布时会给你留一条通知；留言审核出结果（通过/驳回）也会发一条，带「去看看」直达那盏灯。
                </span>
                <Button size="small" disabled={!noticeUnread} onClick={() => markNoticesRead()}>
                    全部已读{noticeUnread ? `（${noticeUnread}）` : ''}
                </Button>
            </div>
            <List
                loading={loadingTab && notices === null}
                dataSource={notices || []}
                locale={{ emptyText: <Empty description="暂无公告和通知" /> }}
                renderItem={(n) => (
                    <List.Item
                        className="ucNoticeRow"
                        onClick={() => setNoticeOpenId(n.id)}
                        actions={[
                            ...(n.link
                                ? [
                                      <Button
                                          className="ucGoBtn"
                                          type="link"
                                          key="go"
                                          onClick={(e) => {
                                              e.stopPropagation()
                                              void openNotice(n)
                                          }}
                                      >
                                          去看看
                                      </Button>,
                                  ]
                                : []),
                            ...(n.isRead
                                ? []
                                : [
                                      <Button
                                          type="link"
                                          key="read"
                                          onClick={(e) => {
                                              e.stopPropagation()
                                              void markNoticesRead([n.id])
                                          }}
                                      >
                                          标记已读
                                      </Button>,
                                  ]),
                            <span key="delete">{removeNoticeButton(n.id)}</span>,
                        ]}
                    >
                        <List.Item.Meta
                            title={
                                <span className="ucItemTitle">
                                    {!n.isRead && <Badge status="processing" />}
                                    <Tag color={n.type === 'announcement' ? 'geekblue' : 'cyan'}>
                                        {n.type === 'announcement' ? '公告' : '通知'}
                                    </Tag>
                                    {n.title}
                                </span>
                            }
                            description={
                                <div className="ucBody">
                                    <div className="ucBodyText">
                                        <StickerText text={n.content} />
                                    </div>
                                    <div className="ucBodyTime">{fmtMinute(n.createdAt)}</div>
                                </div>
                            }
                        />
                    </List.Item>
                )}
            />
        </div>
    )

    /** 提交重置申请。**回包只有一句中文**（新申请的行 id 不在响应里，也不该在前端
     *  自己编一条 pending 状态出来）：成功后**重读一次额度**，界面上的"待处理"那一块
     *  是从后端读来的事实，不是本地推断。 */
    const doApplyQuota = async () => {
        if (applying) return
        setApplying(true)
        try {
            const res = await applyQuotaReset(applyReason.trim())
            if (!ok(res)) {
                message.error(errMsg(res))
                return
            }
            message.success(res.data.data || '已提交对话额度重置申请')
            setApplyOpen(false)
            setApplyReason('')
            // 写后重读：拿不到就保留旧读数（不本地拼一条"已提交"）
            const after = await getMyQuota()
            if (ok(after)) setQuota(after.data.data)
        } catch {
            message.error('网络异常，请稍后再试')
        } finally {
            setApplying(false)
        }
    }

    const quotaBarPct = quotaPct(quota?.remaining, quota?.limit)
    /** 档位 → 类名后缀。`null`（读不到）与 `unlimited` 都不上色（条本身也不画）。 */
    const quotaLv = quotaLevel(quota?.remaining, quota?.limit)

    const quotaPane = (
        <div className="ucPane">
            <div className="ucPaneBar">
                <span className="ucHint">
                    每轮对话算 1 轮（含检索）；用完就答不了了。这里提交的重置申请要管理员批准，
                    批准后会通过站内通知告诉你。
                </span>
                <Button
                    size="small"
                    disabled={quota === null || !!quota?.pendingRequest}
                    onClick={() => setApplyOpen(true)}
                >
                    {quota?.pendingRequest ? '已提交申请' : '申请重置'}
                </Button>
            </div>
            {quota === null ? (
                <Empty description={loadingTab ? '读取中…' : '额度读不出来'} />
            ) : (
                <div className="ucQuota">
                    <div className="ucQuotaHead">
                        <span className="ucQuotaNums">
                            {quotaBalanceText(quota.remaining, quota.limit)}
                        </span>
                        <span className="ucQuotaHint">
                            {quota.unlimited ? '管理员账号不限额' : quotaUsedHint(quota.used, quota.limit)}
                        </span>
                    </div>
                    {!quota.unlimited && (
                        <div className="ucQuotaBar">
                            <div
                                className={`ucQuotaBarIn${quotaLv ? ` is-${quotaLv}` : ''}`}
                                style={{ width: `${quotaBarPct}%` }}
                            />
                        </div>
                    )}
                    <div className="ucQuotaReq">
                        {quota.pendingRequest ? (
                            <>
                                <div className="ucQuotaReqTitle">已提交重置申请，等管理员处理</div>
                                <div className="ucBodyText">
                                    理由：{quota.pendingRequest.reason || '（没填）'}
                                </div>
                                <div className="ucBodyTime">{fmtMinute(quota.pendingRequest.createdAt)}</div>
                            </>
                        ) : (
                            <div className="ucQuotaHint">没有待处理的申请</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )

    /** 对方的头像：**没上传过就落到站点默认头像**。两个要点：
     *  ① 用 `|| DEFAULT_AVATAR_URL` 而不是 `??`——Rust 侧 `peer_avatar` 的真形状是
     *     `Option<String>`，没设过头像时给的是**空串**；`resolveApiAssetUrl('')` 也返回 ''
     *     （falsy 直通），于是 antd 的 Avatar 拿到 `src=""` 会渲染一个坏 `<img>`：
     *     既不显示默认头像、也不会退回文字兜底 —— 用户看到的就是"显示的不是默认头像"。
     *  ② 传的是**根相对路径**（/default-avatar.png），线上/沙箱都由 HTTP 取到该文件。 */
    const peerAvatar = (m: MessageItem) =>
        <Avatar className="ucMailAvatar" size={40}
                src={resolveApiAssetUrl(m.peerAvatar || '') || DEFAULT_AVATAR_URL} />

    const mailRow = (m: MessageItem, outgoing: boolean) => (
        <List.Item className="ucMailRow" onClick={() => openMail(m, outgoing)}
            actions={[
                <Button type="link" key="open" onClick={event => { event.stopPropagation(); void openMail(m, outgoing) }}>阅读</Button>,
                <span key="delete">{removeMailButton(m.id, outgoing)}</span>,
            ]}>
            {peerAvatar(m)}
            <div className="ucMailRowBox">
                <div className="ucMailHead">
                    <span className="ucMailPeer">
                        {!outgoing && !m.isRead && <Badge status="processing" />}
                        {outgoing ? `发给 ${m.peerName}` : `来自 ${m.peerName}`}
                    </span>
                    <span className="ucMailWhen">{fmtMinute(m.createdAt)}</span>
                </div>
                <div className={`ucMailSubject${m.title ? '' : ' isNone'}`}>{m.title || '（无标题）'}</div>
                <div className="ucMailSnippet">{snippet(m.content)}</div>
            </div>
        </List.Item>
    )

    const mailDetail = (m: MessageItem, outgoing: boolean) => (
        <div className="ucMailDetail">
            <div className="ucMailDetailBar">
                <Button size="small" onClick={() => setOpened(null)}>
                    返回{outgoing ? '发件箱' : '收件箱'}
                </Button>
            </div>
            <div className="ucMailDetailHead">
                {peerAvatar(m)}
                <div>
                    <div className="ucMailPeer">{outgoing ? `发给 ${m.peerName}` : `来自 ${m.peerName}`}</div>
                    <div className="ucMailWhen">{fmtMinute(m.createdAt)}</div>
                </div>
            </div>
            <div className={`ucMailDetailTitle${m.title ? '' : ' isNone'}`}>{m.title || '（无标题）'}</div>
            <div className="ucMailDetailBody">{m.content}</div>
            <div className="ucNoticeDetailFoot">{removeMailButton(m.id, outgoing)}</div>
        </div>
    )

    const composePane = (
        <div className="ucField ucFieldStack ucCompose">
            <span className="ucLabel">写站内信</span>
            <Input
                value={to}
                placeholder="收件人账号或 UID"
                onChange={(e) => setTo(e.target.value)}
            />
            <Input
                value={mailTitle}
                maxLength={60}
                placeholder="信件标题（选填，例如：关于那篇架构文档）"
                onChange={(e) => setMailTitle(e.target.value)}
            />
            <div className="counter-room">
                <Input.TextArea
                    value={body}
                    rows={3}
                    maxLength={500}
                    showCount
                    placeholder="正文（最多 500 字）"
                    onChange={(e) => setBody(e.target.value)}
                />
            </div>
            <div className="ucFieldFoot">
                <span className="ucHint">
                    {editingDraftId != null
                        ? '正在编辑草稿：发送后这条草稿会自动删除'
                        : '本站不提供用户名录，收件人请填对方的账号或 UID'}
                </span>
                <span className="ucComposeBtns">
                    <Button loading={savingDraft} disabled={sending} onClick={doSaveDraft}>
                        存草稿
                    </Button>
                    <Button className="ucSendBtn ucPrimaryBtn" type="primary" loading={sending} onClick={doSend}>
                        发送
                    </Button>
                </span>
            </div>
        </div>
    )

    /** 收件箱未读：信箱数据到货就用它，否则先用轮询来的那个数（红点同源） */
    const inboxUnread = mailbox ? mailbox.unread : unreadOf(counts, 'messages')

    const mailboxPane = opened ? (
        <div className="ucPane">{mailDetail(opened.msg, opened.outgoing)}</div>
    ) : (
        <div className="ucPane ucMailPane">
            <Tabs
                size="small"
                activeKey={mailTab}
                onChange={onMailTabChange}
                items={[
                    {
                        key: 'in',
                        label: `收件箱${inboxUnread ? `（未读 ${inboxUnread}）` : ''}`,
                        children: (
                            <>
                                <div className="ucPaneBar">
                                    <span className="ucHint">
                                        {mailbox?.unread ? `未读 ${mailbox.unread} 封` : '没有未读'}
                                    </span>
                                    <Button size="small" disabled={!mailbox?.unread} onClick={markMailRead}>
                                        全部已读
                                    </Button>
                                </div>
                                <List
                                    loading={loadingTab && mailbox === null}
                                    dataSource={mailbox?.inbox || []}
                                    locale={{ emptyText: <Empty description="收件箱是空的" /> }}
                                    renderItem={(m) => mailRow(m, false)}
                                />
                            </>
                        ),
                    },
                    {
                        key: 'out',
                        label: '发件箱',
                        children: (
                            <List
                                loading={loadingTab && mailbox === null}
                                dataSource={mailbox?.outbox || []}
                                locale={{ emptyText: <Empty description="还没发过站内信" /> }}
                                renderItem={(m) => mailRow(m, true)}
                            />
                        ),
                    },
                    {
                        key: 'drafts',
                        label: `草稿箱${drafts?.length ? `（${drafts.length}）` : ''}`,
                        children: (
                            <>
                                <div className="ucPaneBar">
                                    <span className="ucHint">草稿只有你自己看得到；发送后会自动删除</span>
                                    <Button size="small" onClick={newMail}>
                                        写新信
                                    </Button>
                                </div>
                                <List
                                    loading={loadingTab && drafts === null}
                                    dataSource={drafts || []}
                                    locale={{ emptyText: <Empty description="没有草稿" /> }}
                                    renderItem={(d) => (
                                        <List.Item
                                            // 草稿行**不是**可点开的信（没有详情），单独一个类名
                                            // 既是排版钩子也是测试钩子（别复用 .ucMailRow 的 pointer）
                                            className="ucDraftRow"
                                            actions={[
                                                <Button type="link" key="edit" onClick={() => continueDraft(d)}>
                                                    继续写
                                                </Button>,
                                                <Button type="link" danger key="del" onClick={() => dropDraft(d.id)}>
                                                    删除
                                                </Button>,
                                            ]}
                                        >
                                            <div className="ucMailRowBox">
                                                <div className="ucMailHead">
                                                    <span className="ucMailPeer">
                                                        {d.toUsername ? `发给 ${d.toUsername}` : '（还没填收件人）'}
                                                    </span>
                                                    <span className="ucMailWhen">{fmtMinute(d.updatedAt)}</span>
                                                </div>
                                                <div className={`ucMailSubject${d.title ? '' : ' isNone'}`}>
                                                    {d.title || '（无标题）'}
                                                </div>
                                                <div className="ucMailSnippet">{snippet(d.content)}</div>
                                            </div>
                                        </List.Item>
                                    )}
                                />
                            </>
                        ),
                    },
                    { key: 'compose', label: '写站内信', children: composePane },
                ]}
            />
        </div>
    )

    return (
        <ConfigProvider
            theme={{
                algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
                token: { colorPrimary: isDark ? '#ff8ec7' : '#d94f9a' },
            }}
        >
            <Modal
                open={open}
                onCancel={onClose}
                footer={null}
                width={860}
                centered
                title={title}
                // 个人中心要盖住看板娘面板（agent 仓 widget.css 的 #waifu，同阶梯的
                // `--z-agent`），但要在公告弹窗之下。antd 默认的 zIndexPopupBase 是 1000，
                // 与看板娘同值、胜负由 DOM 顺序决定 —— 那是巧合不是设计。
                zIndex={Z.panel}
                // 弹窗挂在 body 下，拿不到 .frontDark 祖先 ⇒ 由 rootClassName 自带主题类。
                // 两个深色类名分工不同、都要挂：`.ucDark` 是本组件自己的夜间补偿
                // （见 index.sass 尾段），`.washiDark` 是那套手账令牌的名字
                // （值在 src/index.css，只是深色档多认这一个类名）。
                rootClassName={`ucRoot${isDark ? ' ucDark washiDark' : ''}`}
                // 标题栏底下现在有一条分割线（见 index.sass），正文别再贴着它
                styles={{ body: { paddingTop: 12 } }}
                // 关窗后**保留**挂载状态：五个页签的数据缓存还在，再打开不必重拉
                // （数据陈旧由"每次打开重拉 profile"+ 各页签的显式刷新兜底）
                destroyOnClose={false}
                forceRender
            >
                {!loggedIn ? (
                    <Empty description="请先登录" />
                ) : (
                    <Tabs
                        activeKey={tab}
                        onChange={onTabChange}
                        items={[
                            { key: 'settings', label: '用户设置', children: settingsPane },
                            {
                                key: 'favorites',
                                label: `收藏的文章${favorites ? `（${favorites.length}）` : ''}`,
                                children: favoritesPane,
                            },
                            {
                                key: 'talks',
                                label: '留言记录',
                                children: talksPane,
                            },
                            {
                                key: 'notices',
                                label: (
                                    <Badge count={unreadOf(counts, 'notifications')} size="small" offset={[8, -2]}>
                                        公告和通知
                                    </Badge>
                                ),
                                children: noticesPane,
                            },
                            {
                                key: 'mailbox',
                                label: (
                                    <Badge count={unreadOf(counts, 'messages')} size="small" offset={[8, -2]}>
                                        站内信箱
                                    </Badge>
                                ),
                                children: mailboxPane,
                            },
                            { key: 'quota', label: '对话额度', children: quotaPane },
                        ]}
                    />
                )}
            </Modal>

            <Modal
                open={applyOpen}
                title="申请重置对话额度"
                okText="提交申请"
                cancelText="再想想"
                confirmLoading={applying}
                onOk={doApplyQuota}
                onCancel={() => setApplyOpen(false)}
                // 叠在个人中心**之上**一档。理由与下面那个头像裁剪弹窗完全一样：本 Modal
                // 是个人中心那个 Modal 的**兄弟节点**，antd 的 `useZIndex` 只在同一 React
                // 子树里继承父级 ⇒ 不给值就落回默认的 1000、被 1200 的父亲压住。
                // 顺带也解决了遮罩打架（同值的话后一块只是把前一块再压暗一层，像"页面变黑"）。
                zIndex={Z.panel + 1}
                // 同上：`ucDark` 管本组件的夜间补偿、`washiDark` 管手账令牌
                rootClassName={`ucRoot${isDark ? ' ucDark washiDark' : ''}`}
                width={520}
            >
                <div className="ucField ucFieldStack">
                    <span className="ucLabel">申请理由（选填）</span>
                    <div className="counter-room">
                        <Input.TextArea
                            value={applyReason}
                            rows={3}
                            // 上限与后端 REASON_MAX 一致。后端超限是**拒绝**而不是截断
                            // （截断会让主人核对的是这一句、库里存的是另一句），
                            // 这里的 maxLength 只是不让主人撞上那句拒绝。
                            maxLength={500}
                            showCount
                            placeholder="例如：想接着问那篇架构文档的问题"
                            onChange={(e) => setApplyReason(e.target.value)}
                        />
                    </div>
                    <span className="ucHint">
                        管理员批准后额度恢复到上限，你立刻可以继续问；驳回的话额度不变，还能再申请。
                    </span>
                </div>
            </Modal>

            <AvatarCropModal
                open={cropOpen}
                file={cropFile}
                uploading={uploading}
                dark={isDark}
                // 与上面申请额度那个弹窗同一档：都是从个人中心窗口里开出来的第二层。
                // **本组件是那个 Modal 的兄弟节点，不是它的子节点** ⇒ antd 的 zIndex
                // 继承链够不着它（`useZIndex` 只认同一 React 子树里的 `zIndexContext`），
                // 不写这一行它就落回默认的 1000、被 1200 的父亲压在下面（看着在、点不动）。
                zIndex={Z.panel + 1}
                onPickFile={handlePickFile}
                onConfirm={handleCropConfirm}
                onCancel={() => {
                    setCropOpen(false)
                    setCropFile(null)
                }}
            />
        </ConfigProvider>
    )

}

export default UserCenter
