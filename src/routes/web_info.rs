use axum::{Json, extract::State};
use sea_orm::{EntityTrait, ColumnTrait, QueryFilter, ActiveModelTrait, Set};
use std::sync::Arc;
use crate::entity::{web_info, user};
use crate::routes::AppState;
use crate::utils::{ApiResponse, encrypt_password};
use serde::{Deserialize, Serialize};
use tracing::info;

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
    #[serde(rename = "socialNeteaseCloud")]
    netease: String,
}

#[derive(Serialize, Deserialize, Default)]
pub struct WebSettingPayload {
    #[serde(rename = "blogTitle")]
    pub blog_title: Option<String>,
    #[serde(rename = "blogAuthor")]
    pub blog_author: Option<String>,
    #[serde(rename = "blogDomain")]
    pub blog_domain: Option<String>,
    #[serde(rename = "blogDescription")]
    pub blog_description: Option<String>,
    #[serde(rename = "blogIcp")]
    pub blog_icp: Option<String>,
    
    #[serde(rename = "userAccount")]
    pub user_account: Option<String>,
    #[serde(rename = "userPassword")]
    pub user_password: Option<String>,
    #[serde(rename = "userAvatar")]
    pub user_avatar: Option<String>,
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
    #[serde(rename = "socialNeteaseCloud")]
    pub social_netease_cloud: Option<String>,
    
    #[serde(rename = "openAiToken")]
    pub openai_token: Option<String>,
    #[serde(rename = "neteaseCookies")]
    pub netease_cookies: Option<String>,
    #[serde(rename = "githubToken")]
    pub github_token: Option<String>,
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

    let (u_acc, u_pass) = (Some("".to_string()), Some("".to_string()));

    let payload = WebSettingPayload {
        blog_title: get_val("blog_title"),
        blog_author: get_val("author"),
        blog_domain: get_direct("blogDomain"),
        blog_description: get_direct("blogDescription"),
        blog_icp: get_val("icp"),
        
        user_account: u_acc,
        user_password: u_pass,
        user_avatar: get_val("avatar"),
        user_talk: get_val("talk"),
        
        social_github: get_direct("socialGithub"),
        social_email: get_direct("socialEmail"),
        social_bilibili: get_direct("socialBilibili"),
        social_qq: get_direct("socialQQ"),
        social_netease_cloud: get_direct("socialNeteaseCloud"),
        
        openai_token: get_direct("openAiToken"),
        netease_cookies: get_direct("neteaseCookies"),
        github_token: get_direct("githubToken"),
    };

    Json(ApiResponse::success(payload))
}

pub async fn get_user_info(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<UserInfoResponse>> {
    let infos = web_info::Entity::find().all(&state.db).await.unwrap_or(vec![]);
    
    let get_val = |k: &str| -> String {
         infos.iter().find(|i| i.key_name == k).map(|i| i.value.clone()).unwrap_or("".to_string())
    };

    let data = UserInfoResponse {
        avatar: get_val("avatar"),
        talk: get_val("talk"), 
        author: get_val("author"),
        title: get_val("blog_title"),
        icp: get_val("icp"),
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
         netease: get_val("socialNeteaseCloud"),
     };
     Json(ApiResponse::success(data))
}

pub async fn update_web_info(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<WebSettingPayload>,
) -> Json<ApiResponse<String>> {
    if let (Some(acc), Some(pass)) = (&payload.user_account, &payload.user_password) {
        if !acc.is_empty() && !pass.is_empty() {
             let user = user::Entity::find_by_id(1).one(&state.db).await.unwrap_or(None);
             if let Some(u) = user {
                 let enc_acc = encrypt_password(acc);
                 let enc_pass = encrypt_password(pass);
                 
                 let mut active: user::ActiveModel = u.into();
                 active.username = Set(enc_acc);
                 active.password = Set(enc_pass);
                 let _ = active.update(&state.db).await;
                 info!("User credentials updated with encryption.");
             }
        }
    }

    let mut map = std::collections::HashMap::new();
    
    if let Some(v) = payload.blog_title { map.insert("blog_title", v); }
    if let Some(v) = payload.blog_author { map.insert("author", v); }
    if let Some(v) = payload.blog_icp { map.insert("icp", v); }
    if let Some(v) = payload.user_avatar { map.insert("avatar", v); }
    if let Some(v) = payload.user_talk { map.insert("talk", v); }
    
    if let Some(v) = payload.blog_domain { map.insert("blogDomain", v); }
    if let Some(v) = payload.blog_description { map.insert("blogDescription", v); }
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
    if let Some(v) = payload.social_netease_cloud { map.insert("socialNeteaseCloud", v); }
    
    if let Some(v) = payload.openai_token { map.insert("openAiToken", v); }
    if let Some(v) = payload.netease_cookies { map.insert("neteaseCookies", v); }
    if let Some(v) = payload.github_token { map.insert("githubToken", v); }

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

pub async fn update_social_info(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SocialInfo>,
) -> Json<ApiResponse<String>> {
    let mut params = std::collections::HashMap::new();
    params.insert("github", payload.github);
    params.insert("qq", payload.qq);
    params.insert("wechat", payload.wechat);
    params.insert("bilibili", payload.bilibili);
    params.insert("email", payload.email);
    params.insert("socialNeteaseCloud", payload.netease);

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
