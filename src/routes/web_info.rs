use axum::{Json, extract::State};
use sea_orm::{EntityTrait, ColumnTrait, QueryFilter, ActiveModelTrait, Set};
use std::sync::Arc;
use crate::entity::{web_info, user};
use crate::routes::AppState;
use crate::utils::ApiResponse;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct UserInfoResponse {
    #[serde(rename = "userAvatar")]
    avatar: String,
    #[serde(rename = "userTalk")]
    talk: String,
    #[serde(rename = "blogAuthor")]
    author: String,
    #[serde(rename = "blogTitle")]
    title: String,
    #[serde(rename = "blogIcp")]
    icp: String,
    /// 公安网安备案号（20260930）。**为空是合法状态**——不是每个站都有，也不该由
    /// 仓库凭空带一个。前端为空则整块不渲染，链接里的数字 code 从这串里正则抽。
    #[serde(rename = "blogPublicIcp")]
    public_icp: String,
    /// 版权署名（20260930）。为空时前端回退到 `blogAuthor`——署名总得有，但**具体是谁**
    /// 属于部署者自己的信息，不进仓库。
    #[serde(rename = "blogCopyright")]
    copyright: String,
}

#[derive(Serialize, Deserialize)]
pub struct SocialInfo {
    #[serde(rename = "socialGithub")]
    github: String,
    #[serde(rename = "socialQQ")]
    qq: String,
    #[serde(rename = "socialWechat")]
    wechat: String,
    #[serde(rename = "socialBilibili")]
    bilibili: String,
    #[serde(rename = "socialEmail")]
    email: String,
}

/// 站点设置面板的读写载荷（20260930 瘦身）。
///
/// 删掉的字段与理由（**别再捡回来**）：
///   · `blogDomain` / `blogDescription` —— 全仓只有"写"没有"读"，从没有任何消费方；
///   · `openAiToken` / `neteaseCookies` / `githubToken` —— 同样是死配置，且本质是
///     **凭据**。它们的活已被 agent 的 `.env` 取代（`web_info` 里那几行如果曾填过，
///     等于把第三方 token 明文存在业务库里、还经由面板接口明文回传）；
///   · `userAccount` / `userPassword` / `userNickname` —— 账号密码的修改入口
///     是登录页与个人中心，不在这里（见 `update_web_info` 的头注）。
#[derive(Serialize, Deserialize, Default)]
pub struct WebSettingPayload {
    #[serde(rename = "blogTitle")]
    pub blog_title: Option<String>,
    #[serde(rename = "blogAuthor")]
    pub blog_author: Option<String>,
    #[serde(rename = "blogIcp")]
    pub blog_icp: Option<String>,
    /// 公安网安备案号（20260930，见 `UserInfoResponse::public_icp`）
    #[serde(rename = "blogPublicIcp")]
    pub blog_public_icp: Option<String>,
    /// 版权署名（20260930）
    #[serde(rename = "blogCopyright")]
    pub blog_copyright: Option<String>,
    /// 个性签名（20260930 从"用户信息"页签迁到"站点信息"）。
    /// 存的是 `web_info` 的 `talk` 键——字段没搬家，只是入口换了地方。
    #[serde(rename = "userTalk")]
    pub user_talk: Option<String>,

    #[serde(rename = "socialGithub")]
    pub social_github: Option<String>,
    #[serde(rename = "socialEmail")]
    pub social_email: Option<String>,
    #[serde(rename = "socialBilibili")]
    pub social_bilibili: Option<String>,
    #[serde(rename = "socialQQ")]
    pub social_qq: Option<String>,

    // 留言审核开关（20260905：AI 审核 + 人工复核，web_info key-value 零迁移存储，
    // 值存 "true"/"false"；缺省 None = 关。读取方 = talks.rs 入库判定 + 面板开关）
    #[serde(rename = "aiReviewEnabled")]
    pub ai_review_enabled: Option<bool>,
    #[serde(rename = "manualReviewEnabled")]
    pub manual_review_enabled: Option<bool>,

    // 文章评论的审核开关（20261002）。**与留言板那两个是两对键**——键名定义在
    // `COMMENT_REVIEW_KEYS`（本文件下半段），这里是它的读写面。
    // 缺省 None 与"键不存在"同义：`web_info` 是 KV 表，没配过就是关，与入库判定
    // 的默认态一致 ⇒ **这个特性不需要迁移**。
    #[serde(rename = "commentAiReviewEnabled")]
    pub comment_ai_review_enabled: Option<bool>,
    #[serde(rename = "commentManualReviewEnabled")]
    pub comment_manual_review_enabled: Option<bool>,

    // 内容风控阈值（20261002 分级禁言）。同样是 KV 表、零迁移。**五个键名与
    // `crate::risk::RISK_KEYS` 逐字相同**（那边是读取侧的唯一实现，这里只做透传）。
    //
    // **缺键回 `None` 而不是 `0`**：两者含义完全不同——`None` = "没配过、用出厂默认"，
    // `0` = "管理员显式关掉了这一档"。合成一个值之后，设置卡第一次打开就会把闸门
    // 全部显示成"已关闭"，而库里其实什么配置都没有。
    #[serde(rename = "contentRateWindowSecs")]
    pub content_rate_window_secs: Option<i64>,
    #[serde(rename = "contentMinIntervalSecs")]
    pub content_min_interval_secs: Option<i64>,
    #[serde(rename = "contentRateLimit")]
    pub content_rate_limit: Option<i64>,
    #[serde(rename = "contentMuteLimit")]
    pub content_mute_limit: Option<i64>,
    #[serde(rename = "contentMuteHours")]
    pub content_mute_hours: Option<i64>,

    // 图库 R2 图床（20261006，用户第 3 条）。键名与 `crate::r2::R2_KEYS` 逐字相同
    // （那边是读取侧与上传判定侧的唯一实现，这里只做透传）。
    //
    // ⚠️ **凭据绝不进这里**：`R2_ENDPOINT` / `R2_ACCESS_KEY` / `R2_SECRET_KEY` 只从
    // `.env` 读（`r2::load_creds`）。这正是本节头注里 `openAiToken`/`githubToken` 被删掉的
    // 同一条理由——`web_info` 是业务库，而这个接口会把每一行**明文回传**给面板。
    // 桶名/前缀/公开域名不是凭据：知道桶名也写不进去任何东西。
    #[serde(rename = "r2ImageBucket")]
    pub r2_image_bucket: Option<String>,
    #[serde(rename = "r2ImagePrefix")]
    pub r2_image_prefix: Option<String>,
    #[serde(rename = "r2ImagePublicBase")]
    pub r2_image_public_base: Option<String>,
    /// 配额（GB，可小数）。缺省/坏值在读取侧回落 9.5（见 `r2::parse_config`）。
    #[serde(rename = "r2ImageQuotaGB")]
    pub r2_image_quota_gb: Option<f64>,
    #[serde(rename = "r2ImageEnabled")]
    pub r2_image_enabled: Option<bool>,
}

pub async fn get_web_settings(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<WebSettingPayload>> {
    let infos = web_info::Entity::find().all(&state.db).await.unwrap_or(vec![]);
    
    let get_val = |target_db_key: &str| -> Option<String> {
         infos.iter().find(|i| i.key_name == target_db_key).map(|i| i.value.clone())
    };
    
    let get_direct = |key: &str| -> Option<String> {
        infos.iter().find(|i| i.key_name == key).map(|i| i.value.clone())
    };

    // 四对审核键名从两个常量取，不在这里手抄字面量：键名是**跨语言契约**
    // （前端按同一串读 JSON 字段、`review_switches_of` 按同一串查库），
    // 散成三份字面量之后，改名会变成"改了这里、闸门还在看旧键"的静默失效。
    let (board_ai, board_manual) = BOARD_REVIEW_KEYS;
    let (comment_ai, comment_manual) = COMMENT_REVIEW_KEYS;

    // 风控阈值：键名从 `risk::RISK_KEYS` 取（**读取侧的判据也在那边**，这里只透传）。
    // 值不是整数（或压根没这个键）→ `None`：设置卡按"用默认值"渲染，
    // 而 `risk::parse_config` 遇到同样的情况也回落默认值 —— 两侧口径一致。
    let risk_num =
        |k: &str| -> Option<i64> { get_direct(k).and_then(|v| v.trim().parse::<i64>().ok()) };
    let [risk_window, risk_gap, risk_rate, risk_mute, risk_hours] =
        crate::risk::RISK_KEYS.map(risk_num);

    // R2 图床的五个键：键名从 `r2::R2_KEYS` 取（同上面两组开关的理由）。
    // 配额回传的是**存着的原文**解析出的数，不是 `r2::parse_config` 算出的生效值：
    // 面板要能显示"你填的是 2"，而生效值另有 `/api/protect/images/r2` 那边报。
    let [r2_bucket, r2_prefix, r2_base, r2_quota, r2_enabled] = crate::r2::R2_KEYS.map(get_direct);
    let r2_quota = r2_quota.and_then(|v| v.trim().parse::<f64>().ok());

    let payload = WebSettingPayload {
        blog_title: get_val("blog_title"),
        blog_author: get_val("author"),
        blog_icp: get_val("icp"),
        blog_public_icp: get_val("publicIcp"),
        blog_copyright: get_val("copyright"),
        user_talk: get_val("talk"),

        social_github: get_direct("socialGithub"),
        social_email: get_direct("socialEmail"),
        social_bilibili: get_direct("socialBilibili"),
        social_qq: get_direct("socialQQ"),

        ai_review_enabled: get_direct(board_ai).map(|v| v == "true"),
        manual_review_enabled: get_direct(board_manual).map(|v| v == "true"),

        comment_ai_review_enabled: get_direct(comment_ai).map(|v| v == "true"),
        comment_manual_review_enabled: get_direct(comment_manual).map(|v| v == "true"),

        content_rate_window_secs: risk_window,
        content_min_interval_secs: risk_gap,
        content_rate_limit: risk_rate,
        content_mute_limit: risk_mute,
        content_mute_hours: risk_hours,

        r2_image_bucket: r2_bucket,
        r2_image_prefix: r2_prefix,
        r2_image_public_base: r2_base,
        r2_image_quota_gb: r2_quota,
        r2_image_enabled: r2_enabled.map(|v| v.trim().eq_ignore_ascii_case("true")),
    };

    Json(ApiResponse::success(payload))
}

/// GET /api/public/user —— 站点公开展示信息（首页头部、文章卡片/详情页的署名、
/// 页脚备案号）。**跨仓契约**：agent 的 `get_blog_info` 工具读它（`tools/base.py`），
/// 所以既有键名与含义不许改，只许加。
///
/// **头像只有一个入口**（20260930）：`user.avatar`（个人中心上传的那张），
/// `web_info.avatar` 只作回退——站点设置里的头像输入框已随"用户信息"页签一起删除，
/// 再留一个"改这里"的入口就是两处改同一份数据。回退是给**老数据**留的路：
/// 在个人中心上传过头像之前，`user.avatar` 是 NULL，此时照旧显示 `web_info.avatar`
/// （改造前存的那张），不会突然变空白。
///
/// **署名同一条规矩**（20260930 用户点名"卡片上的 Sora 换成真正发布作者的昵称"）：
/// `blogAuthor` 优先取 **uid=1 的 `nickname`**（个人中心改的那一个），只有它为空时才
/// 回退到站点设置的 `author` 键。改之前署名有两个真相源——个人中心改了昵称，
/// 首页头部与文章卡片却还显示站点设置里那个旧值。**刻意不回退到 `username`**：
/// 那是登录账号，公开接口没有理由把它印在全站每一张卡片上（`user.nickname` 为空时
/// 站点设置那个值更合适）。
/// 站点级署名（`(author, avatar)`）：**站点主人**是谁——uid=1 的 `nickname`/`avatar`，
/// 为空才回退站点设置（`web_info.author` / `web_info.avatar`，老数据那条路）。
///
/// **两个调用方共用这一份实现**（20261001）：`GET /api/public/user`（头部/页脚/首页大
/// 标题）与文章卡片的**作者回退**（`routes/notes.rs::attach_authors`——文章没有作者记录时
/// 回退到它）。两处口径必须逐字相同，否则同一篇文章在卡片上与页脚上会是两个人名。
pub(crate) async fn site_author(db: &sea_orm::DatabaseConnection) -> (String, String) {
    let infos = web_info::Entity::find().all(db).await.unwrap_or(vec![]);

    let get_val = |k: &str| -> String {
        infos.iter().find(|i| i.key_name == k).map(|i| i.value.clone()).unwrap_or_default()
    };

    // 头像与署名同源（uid=1 那一行），一次查询取两样
    let owner = user::Entity::find_by_id(1).one(db).await.unwrap_or(None);

    let avatar = owner
        .as_ref()
        .and_then(|u| u.avatar.clone())
        .filter(|a| !a.trim().is_empty())
        .unwrap_or_else(|| get_val("avatar"));

    let author = owner
        .as_ref()
        .map(|u| u.nickname.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| get_val("author"));

    (author, avatar)
}

pub async fn get_user_info(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<UserInfoResponse>> {
    let infos = web_info::Entity::find().all(&state.db).await.unwrap_or(vec![]);

    let get_val = |k: &str| -> String {
         infos.iter().find(|i| i.key_name == k).map(|i| i.value.clone()).unwrap_or("".to_string())
    };

    let (author, avatar) = site_author(&state.db).await;

    let data = UserInfoResponse {
        avatar,
        talk: get_val("talk"),
        author,
        title: get_val("blog_title"),
        icp: get_val("icp"),
        public_icp: get_val("publicIcp"),
        copyright: get_val("copyright"),
    };

    Json(ApiResponse::success(data))
}

pub async fn get_social_info(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<SocialInfo>> {
     let infos = web_info::Entity::find().all(&state.db).await.unwrap_or(vec![]);
     
     let get_val = |k: &str| -> String {
         infos.iter().find(|i| i.key_name == k).map(|i| i.value.clone()).unwrap_or("".to_string())
     };

     let data = SocialInfo {
         github: get_val("github"),
         qq: get_val("qq"),
         wechat: get_val("wechat"),
         bilibili: get_val("bilibili"),
         email: get_val("email"),
     };
     Json(ApiResponse::success(data))
}

/// POST /api/protected/websetting —— 站点设置面板的保存。
///
/// **本函数不再碰 `user` 表，这是刻意的**（20260930）：改造前它会顺手把
/// `userAccount`/`userPassword` 写成 uid=1 的账号与密码，也就是**一条绕过登录页的
/// 改凭据后门**——而"账号不可改"本来就是设计（个人中心界面直接这么写）。
/// 现在账号密码只走登录页/个人中心那两条路（`profile.rs::change_password` 会记
/// 令牌代次、会校验旧密码、会有频率限制；这里那条全都没有）。
/// 昵称同理：`PUT /api/protected/profile` 是唯一入口。
pub async fn update_web_info(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<WebSettingPayload>,
) -> Json<ApiResponse<String>> {
    let mut map = std::collections::HashMap::new();

    // ── R2 图床的五个键（20261006）─────────────────────────────────────────
    // **先校验、再落任何一笔**：这个接口是"一次点头办 N 件"，写到一半发现域名填错了
    // 再回滚是做不到的；而"存进去了、却因为格式不对永远不生效"正是最难查的一类
    // （面板上看值好端端在那儿）。所以在进写循环之前就把不合格的挡下来。
    //
    // 读取侧（`r2::parse_config`）是**宽容**的：脏值回落默认、认不出的当未配置。
    // 两侧口径不同是刻意的——读侧要防"库里躺着一行坏数据把整站卡住"，
    // 写侧面对的是**正在打字的人**，此刻能解释清楚，就没有理由把问题存下来。
    let [r2_bucket_key, r2_prefix_key, r2_base_key, r2_quota_key, r2_enabled_key] =
        crate::r2::R2_KEYS;
    if let Some(v) = payload.r2_image_bucket.as_ref() {
        map.insert(r2_bucket_key, v.trim().to_string());
    }
    if let Some(v) = payload.r2_image_prefix.as_ref() {
        // 前缀归一（去两端空白与 `/`）：存进去的就是生效的那个串
        map.insert(r2_prefix_key, crate::r2::normalize_prefix(v));
    }
    if let Some(v) = payload.r2_image_public_base.as_ref() {
        if v.trim().is_empty() {
            // 清空是合法操作 = 回到"未配置"（走本地盘）
            map.insert(r2_base_key, String::new());
        } else {
            match crate::r2::normalize_base(v) {
                Some(base) => map.insert(r2_base_key, base),
                None => {
                    return Json(ApiResponse::error(
                        "R2 公开域名要填完整的 http(s):// 地址（例：https://img.example.com），\
                         末尾斜杠可有可无。这次没有任何设置被保存。",
                    ))
                }
            };
        }
    }
    match payload.r2_image_quota_gb {
        // 缺省 = 这一格没提交（别的页面保存时不会带它）⇒ 不写，保持原值
        None => {}
        Some(gb) if gb.is_finite() && gb > 0.0 => {
            map.insert(r2_quota_key, format!("{gb}"));
        }
        Some(_) => {
            return Json(ApiResponse::error(
                "R2 配额要填一个大于 0 的数字（单位 GB）。这次没有任何设置被保存。",
            ))
        }
    }
    if let Some(v) = payload.r2_image_enabled {
        map.insert(r2_enabled_key, v.to_string());
    }

    if let Some(v) = payload.blog_title { map.insert("blog_title", v); }
    if let Some(v) = payload.blog_author { map.insert("author", v); }
    if let Some(v) = payload.blog_icp { map.insert("icp", v); }
    if let Some(v) = payload.blog_public_icp { map.insert("publicIcp", v); }
    if let Some(v) = payload.blog_copyright { map.insert("copyright", v); }
    if let Some(v) = payload.user_talk { map.insert("talk", v); }

    if let Some(v) = payload.social_github {
        map.insert("socialGithub", v.clone());
        map.insert("github", v);
    }
    if let Some(v) = payload.social_email { 
        map.insert("socialEmail", v.clone()); 
        map.insert("email", v);
    }
    if let Some(v) = payload.social_bilibili { 
        map.insert("socialBilibili", v.clone());
        map.insert("bilibili", v);
    }
    if let Some(v) = payload.social_qq {
        map.insert("socialQQ", v.clone());
        map.insert("qq", v);
    }

    // 四对审核开关：键名同样从常量取（见 `get_web_settings` 同一处的理由）。
    // `Option<bool>` + `if let Some` = **只写请求里带了的那些**：站点设置面板（UserControl）
    // 只提交自己在管的字段，它不会把评论开关顺手写成 false。
    let (board_ai, board_manual) = BOARD_REVIEW_KEYS;
    let (comment_ai, comment_manual) = COMMENT_REVIEW_KEYS;
    if let Some(v) = payload.ai_review_enabled { map.insert(board_ai, v.to_string()); }
    if let Some(v) = payload.manual_review_enabled { map.insert(board_manual, v.to_string()); }
    if let Some(v) = payload.comment_ai_review_enabled { map.insert(comment_ai, v.to_string()); }
    if let Some(v) = payload.comment_manual_review_enabled { map.insert(comment_manual, v.to_string()); }

    // 风控阈值：`Option<i64>` + `if let Some` = 只写请求里带了的那些（同上面四个开关的
    // 理由——设置卡不该顺手改写自己没在管的字段）。**不改这里的语义**：请求里带 `0`
    // 就是把那一档显式关掉，照写不误（`risk::parse_config` 认这个值）。
    // 三条写入路径共用同一组键名常量，与读取侧（`risk::load_config`）必然同源。
    for (key, val) in [
        (crate::risk::RISK_KEYS[0], payload.content_rate_window_secs),
        (crate::risk::RISK_KEYS[1], payload.content_min_interval_secs),
        (crate::risk::RISK_KEYS[2], payload.content_rate_limit),
        (crate::risk::RISK_KEYS[3], payload.content_mute_limit),
        (crate::risk::RISK_KEYS[4], payload.content_mute_hours),
    ] {
        if let Some(v) = val { map.insert(key, v.to_string()); }
    }

    for (k, v) in map {
        let entry = web_info::Entity::find()
            .filter(web_info::Column::KeyName.eq(k))
            .one(&state.db)
            .await;

        match entry {
            Ok(Some(e)) => {
                let mut active: web_info::ActiveModel = e.into();
                active.value = Set(v);
                let _ = active.update(&state.db).await;
            },
            Ok(None) => {
                 let new_entry = web_info::ActiveModel {
                    key_name: Set(k.to_string()),
                    value: Set(v),
                    ..Default::default()
                };
                let _ = web_info::Entity::insert(new_entry).exec(&state.db).await;
            },
            Err(_) => {}
        }
    }

    Json(ApiResponse::success("Settings updated".to_string()))
}

/// PUT /api/protected/social —— 社交媒体信息的**整份替换**（与 `update_web_info` 的
/// 部分更新不同：这里没有 Option，五个键一律照写，空串就是"清空"）。
///
/// 与 `/api/protected/websetting` 的取舍差异（20260930 对齐）：两条路写的是同一份数据，
/// 而**存两份键**是历史遗留——`socialGithub`… 供后台设置页读、`github`… 供前台
/// `/api/public/social` 读。此前这里只写短键，于是经这条路改完，后台设置页仍显示旧值。
/// 现在两条路都写两份，键名不再分叉。（这个端点在全仓没有调用方，属"修好它，别拆掉它"
/// ——拆路由要同步改前端的 API 约定，收益与风险不成比例。）
pub async fn update_social_info(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SocialInfo>,
) -> Json<ApiResponse<String>> {
    let mut params = std::collections::HashMap::new();
    for (long_key, short_key, v) in [
        ("socialGithub", "github", payload.github),
        ("socialQQ", "qq", payload.qq),
        ("socialWechat", "wechat", payload.wechat),
        ("socialBilibili", "bilibili", payload.bilibili),
        ("socialEmail", "email", payload.email),
    ] {
        params.insert(long_key, v.clone());
        params.insert(short_key, v);
    }

    for (k, v) in params {
        let entry = web_info::Entity::find()
            .filter(web_info::Column::KeyName.eq(k))
            .one(&state.db)
            .await;
        
         match entry {
            Ok(Some(e)) => {
                 let mut active: web_info::ActiveModel = e.into();
                active.value = Set(v);
                let _ = active.update(&state.db).await;
            },
            Ok(None) => {
                 let new_entry = web_info::ActiveModel {
                    key_name: Set(k.to_string()),
                    value: Set(v),
                    ..Default::default()
                };
                let _ = web_info::Entity::insert(new_entry).exec(&state.db).await;
            },
             _ => {}
         }
    }

    Json(ApiResponse::success("Social info updated".to_string()))
}

/// 留言板（`src=board`）那两个审核开关的键名。
///
/// **不要改名**：它们是存量数据的键，`web_info` 里已经躺着 "true"/"false"，
/// 改名等于让已经打开的闸静默变成"关"（20260905 起的既有线上配置）。评论用的
/// 是另外两个键（见 `COMMENT_REVIEW_KEYS`），两套开关互不影响。
pub const BOARD_REVIEW_KEYS: (&str, &str) = ("aiReviewEnabled", "manualReviewEnabled");

/// 文章评论那两个审核开关的键名（20261002 评论管理）。
///
/// **不复用留言板那两个**：留言板与评论是两种内容，管理员完全可能只想审其中一种；
/// 共用一个开关之后，"我只想给评论开人工审核"就表达不出来了。
/// 不需要迁移——`web_info` 是 KV 表，缺键的取值天然是"关"，与默认态一致。
///
/// **三个消费方都从这两个常量取，谁都不许手抄字面量**：入库判定
/// （`review_switches_of`）、设置接口的读（`get_web_settings`）、设置接口的写
/// （`update_web_info`）。前端那面按同名 JSON 字段读（`commentAiReviewEnabled` /
/// `commentManualReviewEnabled`，见 `WebSettingPayload`）——改键名一共四处要一起改。
pub const COMMENT_REVIEW_KEYS: (&str, &str) =
    ("commentAiReviewEnabled", "commentManualReviewEnabled");

/// 审核开关读取的**通用形**（20260905，talks.rs 入库前调用）：(AI 审核, 人工复核) 二元组，
/// 值存 "true"/"false"，缺 key/解析失败一律视为关（不影响既有默认全通过的现状）。
///
/// 键名由调用方给：留言板与评论各两个键，规则同一条（见两个 `_KEYS` 常量）。
pub async fn review_switches_of(
    db: &sea_orm::DatabaseConnection,
    ai_key: &str,
    manual_key: &str,
) -> (bool, bool) {
    async fn get_bool(db: &sea_orm::DatabaseConnection, key: &str) -> bool {
        web_info::Entity::find()
            .filter(web_info::Column::KeyName.eq(key))
            .one(db)
            .await
            .ok()
            .flatten()
            .map(|i| i.value == "true")
            .unwrap_or(false)
    }
    (get_bool(db, ai_key).await, get_bool(db, manual_key).await)
}

/// 留言板的两个开关（`BOARD_REVIEW_KEYS` 的薄包装）。
pub async fn review_switches(db: &sea_orm::DatabaseConnection) -> (bool, bool) {
    let (ai_key, manual_key) = BOARD_REVIEW_KEYS;
    review_switches_of(db, ai_key, manual_key).await
}
