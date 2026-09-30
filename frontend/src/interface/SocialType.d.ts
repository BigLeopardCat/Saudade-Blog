/**
 * 社交媒体链接（`GET /api/public/social` 下发，redux 里是 `state.user.social`）。
 *
 * `socialNeteaseCloud` 已于 20260930 删除：全仓没有任何地方渲染它（设置页那个输入框
 * 是它唯一的读者），留着只会让每次填完都以为自己配了点什么。
 * 与后端 `routes/web_info.rs::SocialInfo` **一一对应**，加字段两边一起加。
 */
export interface SocialType{
    socialGithub: string;
    socialEmail: string;
    socialBilibili: string;
    socialQQ: string;
}
