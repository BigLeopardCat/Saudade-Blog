use super::{conflict, missing, Change, Desk, Failure, Opening, Result, Window};
use chrono::{DateTime, Utc};
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend, FromQueryResult,
    Statement, TransactionTrait, Value,
};
use serde::Serialize;

const PAGE_SIZE: usize = 30;
const FIELDS: &str = "id, owner_id, kind, subject, status, version, updated_at";

#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Case {
    id: i32,
    owner_id: i32,
    kind: String,
    subject: String,
    status: String,
    version: i32,
    updated_at: DateTime<Utc>,
}
#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Event {
    id: i32,
    sender: String,
    action: String,
    body: String,
    created_at: DateTime<Utc>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Page<T> {
    items: Vec<T>,
    next_before: Option<i32>,
}
#[derive(Serialize)]
pub(super) struct Details {
    case: Case,
    events: Page<Event>,
}

fn page<T>(mut items: Vec<T>, id: impl Fn(&T) -> i32) -> Page<T> {
    let more = items.len() > PAGE_SIZE;
    items.truncate(PAGE_SIZE);
    Page {
        next_before: if more { items.last().map(id) } else { None },
        items,
    }
}

fn sql(query: impl Into<String>, params: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, params)
}

pub(super) async fn list(
    db: &DatabaseConnection,
    uid: i32,
    desk: Desk,
    w: Window,
) -> Result<Page<Case>> {
    let query = format!(
        "SELECT {FIELDS} FROM support_case WHERE (owner_id=$1 OR $2)
        AND ($3::integer IS NULL OR id<$3) AND ($4::text IS NULL OR status=$4)
        ORDER BY id DESC LIMIT $5"
    );
    let rows = Case::find_by_statement(sql(
        query,
        vec![
            uid.into(),
            desk.staff().into(),
            w.before.into(),
            w.status.into(),
            (PAGE_SIZE as i64 + 1).into(),
        ],
    ))
    .all(db)
    .await?;
    Ok(page(rows, |row| row.id))
}

// The access check and the row lock cover the entire read or update, including its history.
async fn locked(
    tx: &DatabaseTransaction,
    uid: i32,
    desk: Desk,
    id: i32,
    write: bool,
) -> Result<Case> {
    let lock = if write { "FOR UPDATE" } else { "FOR SHARE" };
    let query =
        format!("SELECT {FIELDS} FROM support_case WHERE id=$1 AND (owner_id=$2 OR $3) {lock}");
    Case::find_by_statement(sql(query, vec![id.into(), uid.into(), desk.staff().into()]))
        .one(tx)
        .await?
        .ok_or_else(missing)
}

pub(super) async fn detail(
    db: &DatabaseConnection,
    uid: i32,
    desk: Desk,
    id: i32,
    before: Option<i32>,
) -> Result<Details> {
    let tx = db.begin().await?;
    let case = locked(&tx, uid, desk, id, false).await?;
    let rows = Event::find_by_statement(sql(
        "SELECT id,sender,action,body,created_at FROM support_event
        WHERE case_id=$1 AND ($2::integer IS NULL OR id<$2) ORDER BY id DESC LIMIT $3",
        vec![id.into(), before.into(), (PAGE_SIZE as i64 + 1).into()],
    ))
    .all(&tx)
    .await?;
    let mut events = page(rows, |row| row.id);
    events.items.reverse();
    tx.commit().await?;
    Ok(Details { case, events })
}

#[derive(FromQueryResult)]
struct Receipt {
    action: String,
    body: String,
    sender: String,
    base_version: i32,
}
async fn receipt(
    tx: &DatabaseTransaction,
    case_id: i32,
    uid: i32,
    key: &str,
) -> Result<Option<Receipt>> {
    Ok(Receipt::find_by_statement(sql(
        "SELECT action,body,sender,base_version FROM support_event
        WHERE case_id=$1 AND actor_id=$2 AND request_id=$3",
        vec![case_id.into(), uid.into(), key.into()],
    ))
    .one(tx)
    .await?)
}

struct Entry<'a> {
    case_id: i32,
    uid: i32,
    desk: Desk,
    action: &'a str,
    body: &'a str,
    key: &'a str,
    version: i32,
}
impl Entry<'_> {
    fn matches(&self, prior: &Receipt) -> bool {
        prior.action == self.action
            && prior.body == self.body
            && prior.sender == self.desk.sender()
            && prior.base_version == self.version
    }
    async fn save(&self, tx: &DatabaseTransaction) -> Result<()> {
        tx.execute(sql("INSERT INTO support_event (case_id,actor_id,sender,action,body,request_id,base_version)
            VALUES ($1,$2,$3,$4,$5,$6,$7)", vec![self.case_id.into(),self.uid.into(),self.desk.sender().into(),
            self.action.into(),self.body.into(),self.key.into(),self.version.into()])).await?;
        Ok(())
    }
}

pub(super) async fn open(db: &DatabaseConnection, uid: i32, p: Opening) -> Result<Case> {
    let tx = db.begin().await?;
    let row = Case::find_by_statement(sql(
        format!(
            "INSERT INTO support_case (owner_id,opening_id,kind,subject)
        VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id,opening_id) DO NOTHING RETURNING {FIELDS}"
        ),
        vec![
            uid.into(),
            p.request_id.clone().into(),
            p.kind.clone().into(),
            p.subject.clone().into(),
        ],
    ))
    .one(&tx)
    .await?;
    let created = row.is_some();
    let case = match row {
        Some(case) => case,
        None => Case::find_by_statement(sql(
            format!("SELECT {FIELDS} FROM support_case WHERE owner_id=$1 AND opening_id=$2"),
            vec![uid.into(), p.request_id.clone().into()],
        ))
        .one(&tx)
        .await?
        .ok_or_else(missing)?,
    };
    let evt = Entry {
        case_id: case.id,
        uid,
        desk: Desk::Customer,
        action: if p.kind == "question" {
            "open_question"
        } else {
            "open_ticket"
        },
        body: &p.body,
        key: &p.request_id,
        version: 0,
    };
    if created {
        evt.save(&tx).await?;
    } else if case.subject != p.subject
        || !receipt(&tx, case.id, uid, &p.request_id)
            .await?
            .is_some_and(|r| evt.matches(&r))
    {
        return Err(conflict());
    }
    tx.commit().await?;
    Ok(case)
}

pub(super) async fn change(
    db: &DatabaseConnection,
    uid: i32,
    desk: Desk,
    id: i32,
    p: Change,
) -> Result<Case> {
    let tx = db.begin().await?;
    let case = locked(&tx, uid, desk, id, true).await?;
    let evt = Entry {
        case_id: id,
        uid,
        desk,
        action: &p.action,
        body: &p.body,
        key: &p.request_id,
        version: p.version,
    };
    if let Some(prior) = receipt(&tx, id, uid, &p.request_id).await? {
        if !evt.matches(&prior) {
            return Err(conflict());
        }
        tx.commit().await?;
        return Ok(case);
    }
    if p.version != case.version {
        return Err(conflict());
    }
    let (kind, status) = match p.action.as_str() {
        "reply" if case.status != "resolved" => (
            case.kind.as_str(),
            if desk.staff() {
                "waiting_user"
            } else {
                "waiting_staff"
            },
        ),
        "escalate" if case.kind == "question" && case.status != "resolved" => {
            ("ticket", "waiting_staff")
        }
        "resolve" if case.status != "resolved" => (case.kind.as_str(), "resolved"),
        "reopen" if case.status == "resolved" => (case.kind.as_str(), "waiting_staff"),
        _ => {
            return Err(Failure(
                axum::http::StatusCode::CONFLICT,
                "当前状态无法执行该操作，请刷新记录",
            ))
        }
    };
    let next = Case::find_by_statement(sql(
        format!(
            "UPDATE support_case SET kind=$2,status=$3,version=version+1,
        updated_at=clock_timestamp() WHERE id=$1 RETURNING {FIELDS}"
        ),
        vec![id.into(), kind.into(), status.into()],
    ))
    .one(&tx)
    .await?
    .ok_or_else(missing)?;
    evt.save(&tx).await?;
    tx.commit().await?;
    Ok(next)
}
