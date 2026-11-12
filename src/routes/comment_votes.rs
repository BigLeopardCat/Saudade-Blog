use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use sea_orm::{
    sea_query::{Expr, OnConflict},
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Set,
};
use serde::{Deserialize, Serialize};

use crate::entity::{note_comment, note_comment_vote};
use crate::utils::ApiResponse;

use super::note_stats::{identify, Who};
use super::AppState;

/// 请求体：`+1` 赞 / `-1` 踩 / `0` 撤回。
///
/// **连线协议有三个值、库里只有两个**：`0` 的含义是"把我那一行删掉"，不是"写一个 0"
/// （`note_comment_vote.value` 是 NOT NULL 且只允许 ±1，见迁移文件头注）。
/// 分层不同不矛盾——线协议要让前端一个函数表达三种动作，存储要让唯一键管住"投过没有"。
#[derive(Deserialize)]
pub struct VoteBody {
    pub value: i16,
}

/// 评论列表和投票回执共用票数视图；my_vote 为当前访客的 -1/0/1，up/down 为总数。
#[derive(Serialize, Default, Clone, Copy)]
pub struct CommentVoteDto {
    pub up: i64,
    pub down: i64,
    #[serde(rename = "myVote")]
    pub my_vote: i16,
}

pub(super) async fn vote_counts_for(
    db: &DatabaseConnection,
    ids: &[i32],
) -> Result<HashMap<i32, (i64, i64)>, DbErr> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = note_comment_vote::Entity::find()
        .select_only()
        .column(note_comment_vote::Column::CommentId)
        .column(note_comment_vote::Column::Value)
        .column_as(Expr::col(note_comment_vote::Column::Id).count(), "total")
        .filter(note_comment_vote::Column::CommentId.is_in(ids.to_vec()))
        .group_by(note_comment_vote::Column::CommentId)
        .group_by(note_comment_vote::Column::Value)
        .into_tuple::<(i32, i16, i64)>()
        .all(db)
        .await?;

    let mut out: HashMap<i32, (i64, i64)> = HashMap::new();
    for (cid, value, n) in rows {
        let slot = out.entry(cid).or_insert((0, 0));
        // `value` 只有 ±1（库里没有别的取值，见迁移头注）；真出现别的值就当它不是票，
        // **不折进任何一边**——计数宁可少一个，不要凭空把这个数算进赞或踩。
        if value > 0 {
            slot.0 += n;
        } else if value < 0 {
            slot.1 += n;
        }
    }
    Ok(out)
}

/// 一批评论里**我**投过的那几票（`comment_id → ±1`）。没投过的评论不在表里。
///
/// 身份为 `None`（既没登录也没带访客标识，只有直接 curl 的用户见得到）⇒ 空表短路，
/// 一条查询都不发。
pub(super) async fn my_votes(
    db: &DatabaseConnection,
    ids: &[i32],
    who: Option<&Who>,
) -> HashMap<i32, i16> {
    let Some(who) = who else { return HashMap::new() };
    if ids.is_empty() {
        return HashMap::new();
    }
    note_comment_vote::Entity::find()
        .select_only()
        .column(note_comment_vote::Column::CommentId)
        .column(note_comment_vote::Column::Value)
        .filter(note_comment_vote::Column::CommentId.is_in(ids.to_vec()))
        .filter(who.cond_on(
            note_comment_vote::Column::UserId,
            note_comment_vote::Column::VisitorKey,
        ))
        // 同一个身份在一条评论上最多一行（唯一键保证），但登录态下
        // `cond_on` 会同时匹配"我的行"与"这台浏览器匿名投的行"——理论上两行都在时
        // 取哪一行都行（清匿名行是写入侧的义务），这里定死按 id 倒序取最新的一行，
        // 免得同一份数据两次请求返回不同的高亮。
        .order_by_desc(note_comment_vote::Column::Id)
        .into_tuple::<(i32, i16)>()
        .all(db)
        .await
        .map(|rows| {
            let mut m: HashMap<i32, i16> = HashMap::new();
            for (cid, v) in rows {
                m.entry(cid).or_insert(v);
            }
            m
        })
        .unwrap_or_default()
}

/// 这个身份在**这一条**评论上投的那一票（`0` = 没投）。
async fn my_vote_of(db: &DatabaseConnection, comment_id: i32, who: &Who) -> Result<i16, DbErr> {
    Ok(note_comment_vote::Entity::find()
        .select_only()
        .column(note_comment_vote::Column::Value)
        .filter(note_comment_vote::Column::CommentId.eq(comment_id))
        .filter(who.cond_on(
            note_comment_vote::Column::UserId,
            note_comment_vote::Column::VisitorKey,
        ))
        .order_by_desc(note_comment_vote::Column::Id)
        .into_tuple::<i16>()
        .one(db)
        .await?
        .unwrap_or(0))
}

/// 仅允许操作公开且未删除的评论；不可见与不存在使用相同错误。
async fn visible_comment(db: &DatabaseConnection, id: i32) -> Option<note_comment::Model> {
    note_comment::Entity::find()
        .filter(note_comment::Column::Id.eq(id))
        .filter(note_comment::Column::Approved.eq(1))
        .filter(note_comment::Column::IsDeleted.eq(0))
        .one(db)
        .await
        .ok()
        .flatten()
}

/// 从数据库回读投票状态，避免并发下本地自增失真。
async fn vote_state(
    db: &DatabaseConnection,
    comment_id: i32,
    who: &Who,
) -> Result<CommentVoteDto, DbErr> {
    let (up, down) = vote_counts_for(db, &[comment_id])
        .await?
        .remove(&comment_id)
        .unwrap_or((0, 0));
    Ok(CommentVoteDto {
        up,
        down,
        my_vote: my_vote_of(db, comment_id, who).await?,
    })
}

/// POST /api/public/comments/:id/vote —— 给一条评论投赞/踩，或撤回。
///
/// 唯一键与原子 upsert 保证同方向重复投票不增加票数。
pub async fn vote_comment(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    headers: HeaderMap,
    Json(payload): Json<VoteBody>,
) -> Json<ApiResponse<CommentVoteDto>> {
    // 身份：登录优先，其次浏览器自报的访客标识；两者都没有才回「未登录」
    // （正常前端永远带标识，这一支只有直接 curl 的用户见得到）。
    let who = match identify(&state.db, &headers).await {
        Ok(Some(who)) => who,
        // 令牌在、但已经不能用（过期/收回/冻结）：如实回原因，**不降级成匿名**
        Err(e) => return Json(ApiResponse::error(e.message())),
        Ok(None) => return Json(ApiResponse::error("未登录")),
    };
    // 值域先判：`0` 是合法的"撤回"，别把它当成缺省或错误。
    if !matches!(payload.value, -1 | 0 | 1) {
        return Json(ApiResponse::error("参数不合法"));
    }
    let Some(comment) = visible_comment(&state.db, id).await else {
        return Json(ApiResponse::error("评论不存在"));
    };
    // 所属文章仍要可见：文章转成草稿/私有之后，它的评论在公开侧本就不可达，
    // 不该还能被投上一票（口径与 `create_comment` 的 `note_visible` 一致）。
    if !super::comments::note_visible(&state.db, comment.note_id).await {
        return Json(ApiResponse::error("文章不存在或不可见"));
    }

    let applied = match payload.value {
        0 => withdraw_vote(&state.db, id, &who).await,
        v => set_vote(&state.db, id, &who, v).await,
    };
    if let Err(e) = applied {
        tracing::error!(
            "[comment_vote] 投票失败 comment={} who={} value={}: {}",
            id,
            who.tag(),
            payload.value,
            e
        );
        return Json(ApiResponse::error("操作失败，请稍后再试"));
    }

    match vote_state(&state.db, id, &who).await {
        Ok(dto) => Json(ApiResponse::success(dto)),
        Err(e) => {
            // 票已经写进去了，只是回读失败——**别说"操作失败"**（那是撒谎，
            // 用户再点一次就会把刚投的票撤掉）。如实说读数没取到。
            tracing::error!("[comment_vote] 投票后回读失败 comment={id}: {e}");
            Json(ApiResponse::error("操作已提交，但结果读取失败，请刷新后确认"))
        }
    }
}

async fn withdraw_vote(db: &DatabaseConnection, comment_id: i32, who: &Who) -> Result<(), DbErr> {
    note_comment_vote::Entity::delete_many()
        .filter(note_comment_vote::Column::CommentId.eq(comment_id))
        .filter(who.cond_on(
            note_comment_vote::Column::UserId,
            note_comment_vote::Column::VisitorKey,
        ))
        .exec(db)
        .await?;
    Ok(())
}

/// 原子 upsert 投票值；按登录账号或访客标识选择对应唯一键。
async fn set_vote(
    db: &DatabaseConnection,
    comment_id: i32,
    who: &Who,
    v: i16,
) -> Result<(), DbErr> {
    // 登录投票前移除同一浏览器的匿名票，避免重复计票。
    if let Who::User { key: Some(k), .. } = who {
        note_comment_vote::Entity::delete_many()
            .filter(note_comment_vote::Column::CommentId.eq(comment_id))
            .filter(note_comment_vote::Column::UserId.is_null())
            .filter(note_comment_vote::Column::VisitorKey.eq(k.clone()))
            .exec(db)
            .await?;
    }
    let conflict = match who {
        Who::User { .. } => vec![
            note_comment_vote::Column::CommentId,
            note_comment_vote::Column::UserId,
        ],
        Who::Visitor(_) => vec![
            note_comment_vote::Column::CommentId,
            note_comment_vote::Column::VisitorKey,
        ],
    };
    let (user_id, visitor_key) = match who {
        Who::User { uid, .. } => (Some(*uid), None),
        Who::Visitor(k) => (None, Some(k.clone())),
    };
    let am = note_comment_vote::ActiveModel {
        comment_id: Set(comment_id),
        user_id: Set(user_id),
        visitor_key: Set(visitor_key),
        value: Set(v),
        // created_at / updated_at 交给库的默认值：**不在这里用 `Local::now()` 填一遍**
        // （全库时间列都是 DEFAULT CURRENT_TIMESTAMP，两处各写一遍迟早差出时区）。
        ..Default::default()
    };
    note_comment_vote::Entity::insert(am)
        .on_conflict(
            OnConflict::columns(conflict)
                // 冲突时仅更新票值。
                .update_columns([note_comment_vote::Column::Value])
                .to_owned(),
        )
        // 写入不请求模型返回值，最终状态由 vote_state 回读。
        .exec_without_returning(db)
        .await
        .map(|_| ())
}
