use axum::{Json, extract::State};
use sea_orm::{EntityTrait, ColumnTrait, QueryFilter, DbErr, Set};
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
    #[serde(rename = "blogPublicIcp")]
    public_icp: String,
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

#[derive(Serialize, Deserialize, Default)]
pub struct WebSettingPayload {
    #[serde(rename = "blogTitle")]
    pub blog_title: Option<String>,
    #[serde(rename = "blogAuthor")]
    pub blog_author: Option<String>,
    #[serde(rename = "blogIcp")]
    pub blog_icp: Option<String>,
    #[serde(rename = "blogPublicIcp")]
    pub blog_public_icp: Option<String>,
    #[serde(rename = "blogCopyright")]
    pub blog_copyright: Option<String>,
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

    #[serde(rename = "aiReviewEnabled")]
    pub ai_review_enabled: Option<bool>,
    #[serde(rename = "manualReviewEnabled")]
    pub manual_review_enabled: Option<bool>,

    #[serde(rename = "commentAiReviewEnabled")]
    pub comment_ai_review_enabled: Option<bool>,
    #[serde(rename = "commentManualReviewEnabled")]
    pub comment_manual_review_enabled: Option<bool>,

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
    let infos = match web_info::Entity::find().all(&state.db).await {
        Ok(rows) => rows,
        Err(e) => return super::db_error("读取站点设置", &e),
    };
    
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

pub async fn update_web_info(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<WebSettingPayload>,
) -> Json<ApiResponse<String>> {
    let mut map = std::collections::HashMap::new();

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

    if let Err(e) = save_settings(&state.db, map).await {
        return super::db_error("保存站点设置", &e);
    }

    Json(ApiResponse::success("Settings updated".to_string()))
}

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

    if let Err(e) = save_settings(&state.db, params).await {
        return super::db_error("保存社交信息", &e);
    }

    Json(ApiResponse::success("Social info updated".to_string()))
}

/// 一条 UPSERT 保存整份变更；任一键失败则整条语句回滚。排序避免并发批次锁顺序相反。
async fn save_settings(
    db: &sea_orm::DatabaseConnection,
    params: std::collections::HashMap<&str, String>,
) -> Result<(), DbErr> {
    if params.is_empty() { return Ok(()); }
    let mut params: Vec<_> = params.into_iter().collect();
    params.sort_unstable_by(|a, b| a.0.cmp(b.0));
    let rows = params.into_iter().map(|(key, value)| web_info::ActiveModel {
        key_name: Set(key.to_string()), value: Set(value), ..Default::default()
    });
    web_info::Entity::insert_many(rows)
        .on_conflict(sea_orm::sea_query::OnConflict::column(web_info::Column::KeyName)
            .update_column(web_info::Column::Value).to_owned())
        .exec(db).await?;
    Ok(())
}

pub const BOARD_REVIEW_KEYS: (&str, &str) = ("aiReviewEnabled", "manualReviewEnabled");

pub const COMMENT_REVIEW_KEYS: (&str, &str) =
    ("commentAiReviewEnabled", "commentManualReviewEnabled");

/// 缺键保留首次安装时的关闭默认值；查询失败或非法值必须阻止内容提交。
/// 两个键在一次查询中读取，避免混合两次查询之间的配置版本。
pub async fn review_switches_of(
    db: &sea_orm::DatabaseConnection,
    ai_key: &str,
    manual_key: &str,
) -> Result<(bool, bool), DbErr> {
    let rows = web_info::Entity::find()
        .filter(web_info::Column::KeyName.is_in([ai_key, manual_key]))
        .all(db).await?;
    let read = |key: &str| -> Result<bool, DbErr> {
        match rows.iter().find(|row| row.key_name == key).map(|row| row.value.as_str()) {
            None | Some("false") => Ok(false),
            Some("true") => Ok(true),
            Some(_) => Err(DbErr::Custom(format!("审核开关 {key} 的值非法"))),
        }
    };
    Ok((read(ai_key)?, read(manual_key)?))
}

/// 留言板的两个开关（`BOARD_REVIEW_KEYS` 的薄包装）。
pub async fn review_switches(db: &sea_orm::DatabaseConnection) -> Result<(bool, bool), DbErr> {
    let (ai_key, manual_key) = BOARD_REVIEW_KEYS;
    review_switches_of(db, ai_key, manual_key).await
}
