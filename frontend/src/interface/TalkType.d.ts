export interface Talk{
    talkKey: number;
    talkTitle: string,
    content: string,
    createTime: Date
    updateTime: Date
    /** 发布者展示名（昵称优先；账号已销是 `用户#<id>`）。**只有说说会带**——
     *  河灯留言的公开行不带账号身份，那里是自由留名 `author`。 */
    nickname?: string | null
    /** 发布者头像。同样只有说说会带。 */
    avatar?: string | null
}

export interface updateTalk{
    content: string
    updateTime: string
    talkTitle: string
}