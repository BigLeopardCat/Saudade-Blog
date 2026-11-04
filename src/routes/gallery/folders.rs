use super::*;
use sea_orm::TransactionTrait;

#[derive(Default, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i32,
    pub parent_id: i32,
    pub name: String,
    pub image_count: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    pub name: String,
    #[serde(default)]
    pub parent_id: i32,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    pub parent_id: Option<i32>,
    pub before: Option<i32>,
    pub limit: Option<u64>,
    pub id: Option<i32>,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> Json<ApiResponse<Vec<Folder>>> {
    let result = async {
        let limit = q.limit.unwrap_or(1000);
        if !(1..=1000).contains(&limit) || q.parent_id.is_some_and(|v| v < 0)
            || q.before.is_some_and(|v| v < 0) || q.id.is_some_and(|v| v <= 0) {
            return Err(DbErr::Custom("invalid folder page".into()));
        }
        let mut sql = "SELECT f.id,COALESCE(f.parent_id,0) AS parent_id,f.name,count(m.image_id)::bigint AS image_count \
             FROM image_folder f LEFT JOIN image_metadata m ON m.folder_id=f.id WHERE true".to_owned();
        let mut args: Vec<Value> = Vec::new();
        for (column, value) in [("COALESCE(f.parent_id,0)",q.parent_id),("f.id",q.id)] {
            if let Some(value)=value { args.push(value.into());sql.push_str(&format!(" AND {column}=${}",args.len())); }
        }
        if let Some(before)=q.before {args.push(before.into());sql.push_str(&format!(" AND f.id>${}",args.len()));}
        args.push((limit as i64).into());
        sql.push_str(&format!(" GROUP BY f.id ORDER BY f.id LIMIT ${}",args.len()));
        Folder::find_by_statement(Statement::from_sql_and_values(DatabaseBackend::Postgres,sql,args)).all(&state.db).await
    }.await;
    response(result)
}

pub(super) async fn create_in<C: ConnectionTrait>(db: &C, input: Create) -> Result<Folder, DbErr> {
    let name = input.name.trim();
    if name.is_empty()
        || name.chars().count() > 80
        || name.contains(['/', '\\'])
        || matches!(name, "." | "..")
        || input.parent_id < 0
    {
        return Err(DbErr::Custom("invalid folder name".into()));
    }
    if input.parent_id > 0 {
        let row = db.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "WITH RECURSIVE parents AS (SELECT id,parent_id FROM image_folder WHERE id=$1 \
             UNION ALL SELECT f.id,f.parent_id FROM image_folder f JOIN parents p ON f.id=p.parent_id) \
             SELECT count(*)::bigint AS depth FROM parents", vec![input.parent_id.into()])).await?
            .ok_or_else(|| DbErr::Custom("folder unavailable".into()))?;
        let depth: i64 = row.try_get("", "depth")?;
        if !(1..8).contains(&depth) {
            return Err(DbErr::Custom("invalid folder depth".into()));
        }
    }
    Folder::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO image_folder(parent_id,name) VALUES(NULLIF($1,0),$2) \
         RETURNING id,COALESCE(parent_id,0) AS parent_id,name,0::bigint AS image_count",
        vec![input.parent_id.into(), name.into()],
    ))
    .one(db)
    .await?
    .ok_or_else(|| DbErr::Custom("folder not created".into()))
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(input): Json<Create>,
) -> Json<ApiResponse<Folder>> {
    response(create_in(&state.db, input).await)
}

pub async fn remove(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Json<ApiResponse<bool>> {
    let result = async {
        let txn = state.db.begin().await?;
        let result = txn
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "DELETE FROM image_folder f WHERE id=$1 \
             AND NOT EXISTS(SELECT 1 FROM image_folder c WHERE c.parent_id=f.id) \
             AND NOT EXISTS(SELECT 1 FROM image_metadata m WHERE m.folder_id=f.id)",
                vec![id.into()],
            ))
            .await?;
        if result.rows_affected != 1 {
            return Err(DbErr::Custom("folder missing or not empty".into()));
        }
        txn.commit().await?;
        Ok(true)
    }
    .await;
    response(result)
}
