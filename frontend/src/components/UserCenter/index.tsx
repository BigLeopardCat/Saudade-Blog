import {t as tr, useLocale} from '../../i18n';
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
import {useAuthToken} from '../../utils/useAuthToken';
import {getTokenClaims} from '../../utils/auth';
import type {MessageItem, NotificationItem} from '../../interface/ProfileType';

interface UserCenterProps {
    open: boolean
    onClose: () => void
}

const UserCenterContent = ({open,onClose}: UserCenterProps) => {
    useLocale();
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
            <span className="ucTitleText">{tr("个人中心")}</span>
            {admin && (
                <Button
                    size="small"
                    type="link"
                    onClick={() => {
                        onClose()
                        navigate('/dashboard')
                    }}
                >
                    {tr("后台管理")}</Button>
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
                    <div className="ucAvatarAccount">{tr("账号：")}{profile?.username || ''}{tr("（账号不可修改）")}</div>
                    <label className="ucUploadBtn">
                        {tr("更换头像")}<input
                            type="file"
                            accept="image/*"
                            onChange={(e) => {
                                const f = e.target.files?.[0]
                                e.target.value = ''
                                if (!f) return
                                if (!f.type.startsWith('image/')) {
                                    message.error(tr("请选择图片文件"))
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
                    message={tr("你的昵称和其他用户重复了")}
                    description={
                        <>{tr("为避免重名，系统已把它临时改成「")}{profile?.nickname || ''}{tr("」。 请在下面改成别的昵称，改完这条提示就消失。")}</>
                    }
                />
            )}

            {profile?.muted && (
                <Alert
                    className="ucMuteBanner"
                    type="warning"
                    showIcon
                    message={tr("你暂时不能发布评论与留言")}
                    description={
                        <>{tr("你的账号被临时禁言")}{profile?.mutedUntil ? `（${profile.mutedUntil}）` : ''}{tr("， 期间发出的评论与留言会被拒；其余一切照常——仍可登录、浏览文章、与泠月喵对话。 如有疑问请联系博主。")}</>
                    }
                />
            )}

            <div className="ucField">
                <span className="ucLabel">{tr("昵称")}</span>
                <Input
                    value={nickname}
                    maxLength={20}
                    showCount
                    placeholder={tr("展示用昵称（留言、说说、信箱里显示这个）")}
                    onChange={(e) => setNickname(e.target.value)}
                />
                <Button className="ucPrimaryBtn" type="primary" loading={savingNick} onClick={saveNickname}>
                    {tr("保存")}</Button>
            </div>

            {open && (
                <div className="ucField ucFieldStack">
                    <span className="ucLabel">{tr("修改密码")}</span>
                    <Input.Password
                        value={pwdOld}
                        placeholder={tr("原密码")}
                        autoComplete="current-password"
                        onChange={(e) => setPwdOld(e.target.value)}
                    />
                    <Input.Password
                        value={pwdNew}
                        placeholder={tr("新密码（至少 8 位）")}
                        autoComplete="new-password"
                        onChange={(e) => setPwdNew(e.target.value)}
                    />
                    <Input.Password
                        value={pwdNew2}
                        placeholder={tr("再输一次新密码")}
                        autoComplete="new-password"
                        onChange={(e) => setPwdNew2(e.target.value)}
                    />
                    <div className="ucFieldFoot">
                        <span className="ucHint">{tr("改密码会让其他设备立刻下线（本机保持登录）")}</span>
                        <Button className="ucPrimaryBtn" type="primary" loading={savingPwd} onClick={savePassword}>
                            {tr("修改密码")}</Button>
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
                        ? <Empty description={tr("收藏列表没读到（网络或登录状态问题），过一会儿再打开看看")} />
                        : <Empty description={tr("还没有收藏的文章（文章页点「收藏」）")} />,
                }}
                renderItem={(item) => (
                    <List.Item
                        actions={[
                            <Button type="link" key="open" onClick={() => openArticle(item.noteId)}>
                                {tr("阅读")}</Button>,
                            <Button type="link" danger key="del" onClick={() => dropFavorite(item.noteId)}>
                                {tr("取消收藏")}</Button>,
                        ]}
                    >
                        <List.Item.Meta
                            title={
                                <a onClick={() => openArticle(item.noteId)} className="ucItemTitle">
                                    {item.title}
                                </a>
                            }
                            description={tr("收藏于 {0}", {"0": fmtMinute(item.createdAt)})}
                        />
                    </List.Item>
                )}
            />
        </div>
    )

    const talksPane = (
        <div className="ucPane">
            <div className="ucPaneBar">
                <span className="ucHint">{tr("这里只列河灯留言（说说在「说说」页）")}</span>
            </div>
            <List
                loading={loadingTab && talks === null}
                dataSource={boardTalks}
                locale={{ emptyText: <Empty description={tr("还没有留言记录")} /> }}
                renderItem={(t) => {
                    const st = TALK_STATUS[t.approved] || { text: tr("未知"), color: 'default' }
                    return (
                        <List.Item>
                            <List.Item.Meta
                                title={
                                    <span className="ucItemTitle">
                                        {t.cat && <span className="ucSeal" title={tr("河灯留言的类型")}>{t.cat}</span>}
                                        {t.content ? t.content.slice(0, 24) : tr("（无标题）")}
                                        <Tag color={st.color}>{tr(st.text)}</Tag>
                                    </span>
                                }
                                description={
                                    <div className="ucBody">
                                        <div className="ucBodyText">{t.content}</div>
                                        {t.approved === 2 && (
                                            <div className="ucReject">
                                                {tr("驳回理由：")}{t.rejectReason || tr("未填写")}
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

    /** Resolve the selected notification from refreshed data by ID. */
    const openedNotice =
        noticeOpenId == null ? null : (notices || []).find((n) => n.id === noticeOpenId) || null

    const noticeDetail = (n: NotificationItem) => (
        <div className="ucNoticeDetail">
            <div className="ucNoticeDetailBar">
                <Button size="small" onClick={() => setNoticeOpenId(null)}>
                    {tr("返回公告和通知")}</Button>
            </div>
            <div className="ucNoticeDetailHead">
                <Tag color={n.type === 'announcement' ? 'geekblue' : 'cyan'}>
                    {n.type === 'announcement' ? tr("公告") : tr("通知")}
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
                        {tr("去看看")}</Button>
                ) : null}
                {n.isRead ? (
                    <span className="ucHint">{tr("已读")}</span>
                ) : (
                    <Button type="primary" onClick={() => markNoticesRead([n.id])}>
                        {tr("标记为已读")}</Button>
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
                    {tr("公告在发布时会给你留一条通知；留言审核出结果（通过/驳回）也会发一条，带「去看看」直达那盏灯。")}</span>
                <Button size="small" disabled={!noticeUnread} onClick={() => markNoticesRead()}>
                    {tr("全部已读")}{noticeUnread ? `（${noticeUnread}）` : ''}
                </Button>
            </div>
            <List
                loading={loadingTab && notices === null}
                dataSource={notices || []}
                locale={{ emptyText: <Empty description={tr("暂无公告和通知")} /> }}
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
                                          {tr("去看看")}</Button>,
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
                                          {tr("标记已读")}</Button>,
                                  ]),
                            <span key="delete">{removeNoticeButton(n.id)}</span>,
                        ]}
                    >
                        <List.Item.Meta
                            title={
                                <span className="ucItemTitle">
                                    {!n.isRead && <Badge status="processing" />}
                                    <Tag color={n.type === 'announcement' ? 'geekblue' : 'cyan'}>
                                        {n.type === 'announcement' ? tr("公告") : tr("通知")}
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

    /** Submit the request, then reread authoritative quota state. */
    const doApplyQuota = async () => {
        if (applying) return
        setApplying(true)
        try {
            const res = await applyQuotaReset(applyReason.trim())
            if (!ok(res)) {
                message.error(errMsg(res))
                return
            }
            message.success(res.data.data || tr("已提交对话额度重置申请"))
            setApplyOpen(false)
            setApplyReason('')
            const after = await getMyQuota()
            if (ok(after)) setQuota(after.data.data)
        } catch {
            message.error(tr("网络异常，请稍后再试"))
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
                    {tr("每轮对话算 1 轮（含检索）；用完就答不了了。这里提交的重置申请要管理员批准， 批准后会通过站内通知告诉你。")}</span>
                <Button
                    size="small"
                    disabled={quota === null || !!quota?.pendingRequest}
                    onClick={() => setApplyOpen(true)}
                >
                    {quota?.pendingRequest ? tr("已提交申请") : tr("申请重置")}
                </Button>
            </div>
            {quota === null ? (
                <Empty description={loadingTab ? tr("读取中…") : tr("额度读不出来")} />
            ) : (
                <div className="ucQuota">
                    <div className="ucQuotaHead">
                        <span className="ucQuotaNums">
                            {tr(quotaBalanceText(quota.remaining, quota.limit))}
                        </span>
                        <span className="ucQuotaHint">
                            {quota.unlimited ? tr("管理员账号不限额") : tr(quotaUsedHint(quota.used, quota.limit))}
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
                                <div className="ucQuotaReqTitle">{tr("已提交重置申请，等管理员处理")}</div>
                                <div className="ucBodyText">
                                    {tr("理由：")}{quota.pendingRequest.reason || tr("（没填）")}
                                </div>
                                <div className="ucBodyTime">{fmtMinute(quota.pendingRequest.createdAt)}</div>
                            </>
                        ) : (
                            <div className="ucQuotaHint">{tr("没有待处理的申请")}</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )

    /** Sender avatars never fall back to the current viewer. */
    const peerAvatar = (m: MessageItem) =>
        <Avatar className="ucMailAvatar" size={40}
                src={resolveApiAssetUrl(m.peerAvatar || '') || DEFAULT_AVATAR_URL} />

    const mailRow = (m: MessageItem, outgoing: boolean) => (
        <List.Item className="ucMailRow" onClick={() => openMail(m, outgoing)}
            actions={[
                <Button type="link" key="open" onClick={event => { event.stopPropagation(); void openMail(m, outgoing) }}>{tr("阅读")}</Button>,
                <span key="delete">{removeMailButton(m.id, outgoing)}</span>,
            ]}>
            {peerAvatar(m)}
            <div className="ucMailRowBox">
                <div className="ucMailHead">
                    <span className="ucMailPeer">
                        {!outgoing && !m.isRead && <Badge status="processing" />}
                        {outgoing ? tr("发给 {0}", {"0": m.peerName}) : tr("来自 {0}", {"0": m.peerName})}
                    </span>
                    <span className="ucMailWhen">{fmtMinute(m.createdAt)}</span>
                </div>
                <div className={`ucMailSubject${m.title ? '' : ' isNone'}`}>{m.title || tr("（无标题）")}</div>
                <div className="ucMailSnippet">{snippet(m.content)}</div>
            </div>
        </List.Item>
    )

    const mailDetail = (m: MessageItem, outgoing: boolean) => (
        <div className="ucMailDetail">
            <div className="ucMailDetailBar">
                <Button size="small" onClick={() => setOpened(null)}>
                    {tr("返回")}{outgoing ? tr("发件箱") : tr("收件箱")}
                </Button>
            </div>
            <div className="ucMailDetailHead">
                {peerAvatar(m)}
                <div>
                    <div className="ucMailPeer">{outgoing ? tr("发给 {0}", {"0": m.peerName}) : tr("来自 {0}", {"0": m.peerName})}</div>
                    <div className="ucMailWhen">{fmtMinute(m.createdAt)}</div>
                </div>
            </div>
            <div className={`ucMailDetailTitle${m.title ? '' : ' isNone'}`}>{m.title || tr("（无标题）")}</div>
            <div className="ucMailDetailBody">{m.content}</div>
            <div className="ucNoticeDetailFoot">{removeMailButton(m.id, outgoing)}</div>
        </div>
    )

    const composePane = (
        <div className="ucField ucFieldStack ucCompose">
            <span className="ucLabel">{tr("写站内信")}</span>
            <Input
                value={to}
                placeholder={tr("收件人账号或 UID")}
                onChange={(e) => setTo(e.target.value)}
            />
            <Input
                value={mailTitle}
                maxLength={60}
                placeholder={tr("信件标题（选填，例如：关于那篇架构文档）")}
                onChange={(e) => setMailTitle(e.target.value)}
            />
            <div className="counter-room">
                <Input.TextArea
                    value={body}
                    rows={3}
                    maxLength={500}
                    showCount
                    placeholder={tr("正文（最多 500 字）")}
                    onChange={(e) => setBody(e.target.value)}
                />
            </div>
            <div className="ucFieldFoot">
                <span className="ucHint">
                    {editingDraftId != null
                        ? tr("正在编辑草稿：发送后这条草稿会自动删除")
                        : tr("本站不提供用户名录，收件人请填对方的账号或 UID")}
                </span>
                <span className="ucComposeBtns">
                    <Button loading={savingDraft} disabled={sending} onClick={doSaveDraft}>
                        {tr("存草稿")}</Button>
                    <Button className="ucSendBtn ucPrimaryBtn" type="primary" loading={sending} onClick={doSend}>
                        {tr("发送")}</Button>
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
                        label: inboxUnread ? tr("收件箱（未读 {count}）", {count: inboxUnread}) : tr("收件箱"),
                        children: (
                            <>
                                <div className="ucPaneBar">
                                    <span className="ucHint">
                                        {mailbox?.unread ? tr("未读 {0} 封", {"0": mailbox.unread}) : tr("没有未读")}
                                    </span>
                                    <Button size="small" disabled={!mailbox?.unread} onClick={markMailRead}>
                                        {tr("全部已读")}</Button>
                                </div>
                                <List
                                    loading={loadingTab && mailbox === null}
                                    dataSource={mailbox?.inbox || []}
                                    locale={{ emptyText: <Empty description={tr("收件箱是空的")} /> }}
                                    renderItem={(m) => mailRow(m, false)}
                                />
                            </>
                        ),
                    },
                    {
                        key: 'out',
                        label: tr("发件箱"),
                        children: (
                            <List
                                loading={loadingTab && mailbox === null}
                                dataSource={mailbox?.outbox || []}
                                locale={{ emptyText: <Empty description={tr("还没发过站内信")} /> }}
                                renderItem={(m) => mailRow(m, true)}
                            />
                        ),
                    },
                    {
                        key: 'drafts',
                        label: drafts?.length ? tr("草稿箱（{count}）", {count: drafts.length}) : tr("草稿箱"),
                        children: (
                            <>
                                <div className="ucPaneBar">
                                    <span className="ucHint">{tr("草稿只有你自己看得到；发送后会自动删除")}</span>
                                    <Button size="small" onClick={newMail}>
                                        {tr("写新信")}</Button>
                                </div>
                                <List
                                    loading={loadingTab && drafts === null}
                                    dataSource={drafts || []}
                                    locale={{ emptyText: <Empty description={tr("没有草稿")} /> }}
                                    renderItem={(d) => (
                                        <List.Item
                                            className="ucDraftRow"
                                            actions={[
                                                <Button type="link" key="edit" onClick={() => continueDraft(d)}>
                                                    {tr("继续写")}</Button>,
                                                <Button type="link" danger key="del" onClick={() => dropDraft(d.id)}>
                                                    {tr("删除")}</Button>,
                                            ]}
                                        >
                                            <div className="ucMailRowBox">
                                                <div className="ucMailHead">
                                                    <span className="ucMailPeer">
                                                        {d.toUsername ? tr("发给 {0}", {"0": d.toUsername}) : tr("（还没填收件人）")}
                                                    </span>
                                                    <span className="ucMailWhen">{fmtMinute(d.updatedAt)}</span>
                                                </div>
                                                <div className={`ucMailSubject${d.title ? '' : ' isNone'}`}>
                                                    {d.title || tr("（无标题）")}
                                                </div>
                                                <div className="ucMailSnippet">{snippet(d.content)}</div>
                                            </div>
                                        </List.Item>
                                    )}
                                />
                            </>
                        ),
                    },
                    { key: 'compose', label: tr("写站内信"), children: composePane },
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
                zIndex={Z.panel}
                rootClassName={`ucRoot${isDark ? ' ucDark washiDark' : ''}`}
                styles={{ body: { paddingTop: 12 } }}
                destroyOnClose={false}
                forceRender
            >
                {!loggedIn ? (
                    <Empty description={tr("请先登录")} />
                ) : (
                    <Tabs
                        activeKey={tab}
                        onChange={onTabChange}
                        items={[
                            { key: 'settings', label: tr("用户设置"), children: settingsPane },
                            {
                                key: 'favorites',
                                label: favorites ? tr("收藏的文章（{count}）", {count: favorites.length}) : tr("收藏的文章"),
                                children: favoritesPane,
                            },
                            {
                                key: 'talks',
                                label: tr("留言记录"),
                                children: talksPane,
                            },
                            {
                                key: 'notices',
                                label: (
                                    <Badge count={unreadOf(counts, 'notifications')} size="small" offset={[8, -2]}>
                                        {tr("公告和通知")}</Badge>
                                ),
                                children: noticesPane,
                            },
                            {
                                key: 'mailbox',
                                label: (
                                    <Badge count={unreadOf(counts, 'messages')} size="small" offset={[8, -2]}>
                                        {tr("站内信箱")}</Badge>
                                ),
                                children: mailboxPane,
                            },
                            { key: 'quota', label: tr("对话额度"), children: quotaPane },
                        ]}
                    />
                )}
            </Modal>

            <Modal
                open={applyOpen}
                title={tr("申请重置对话额度")}
                okText={tr("提交申请")}
                cancelText={tr("再想想")}
                confirmLoading={applying}
                onOk={doApplyQuota}
                onCancel={() => setApplyOpen(false)}
                zIndex={Z.panel + 1}
                rootClassName={`ucRoot${isDark ? ' ucDark washiDark' : ''}`}
                width={520}
            >
                <div className="ucField ucFieldStack">
                    <span className="ucLabel">{tr("申请理由（选填）")}</span>
                    <div className="counter-room">
                        <Input.TextArea
                            value={applyReason}
                            rows={3}
                            maxLength={500}
                            showCount
                            placeholder={tr("例如：想接着问那篇架构文档的问题")}
                            onChange={(e) => setApplyReason(e.target.value)}
                        />
                    </div>
                    <span className="ucHint">
                        {tr("管理员批准后额度恢复到上限，你立刻可以继续问；驳回的话额度不变，还能再申请。")}</span>
                </div>
            </Modal>

            <AvatarCropModal
                open={cropOpen}
                file={cropFile}
                uploading={uploading}
                dark={isDark}
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

export default function UserCenter(props: UserCenterProps) {
    useLocale();
    const claims = getTokenClaims(useAuthToken())
    // Account changes remount private views and forms without placing credentials in React keys.
    const scope = claims ? `${claims.sub}:${claims.role}` : 'anonymous'
    return <UserCenterContent key={scope} {...props}/>
}
