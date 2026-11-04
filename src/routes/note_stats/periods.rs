//! Calendar period aggregation and period report endpoint.

use super::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Granularity {
    Week,
    Month,
    Year,
}

impl Granularity {
    pub(super) fn parse(s: &str) -> Option<Self> {
        match s {
            "week" => Some(Self::Week),
            "month" => Some(Self::Month),
            "year" => Some(Self::Year),
            _ => None,
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Week => "week",
            Self::Month => "month",
            Self::Year => "year",
        }
    }

    /// 默认期数。**一周一期看一年、一月一期看一年、一年一期看五年**——
    /// 都是"列表一屏能扫完"的量级。上限同理（`limit` 是外部入参，不设上限
    /// 等于让人一次拉十年）。
    pub(super) fn default_limit(self) -> usize {
        match self {
            Self::Week => 12,
            Self::Month => 12,
            Self::Year => 5,
        }
    }

    pub(super) fn max_limit(self) -> usize {
        match self {
            Self::Week => 26,
            Self::Month => 24,
            Self::Year => 10,
        }
    }
}

/// 一期的边界（闭区间，都是本地日期）。
pub(super) struct Period {
    pub(super) key: String,
    pub(super) label: String,
    pub(super) start: chrono::NaiveDate,
    pub(super) end: chrono::NaiveDate,
}

/// 往回数第 `back` 期的边界。
///
/// 期界一律在 Rust 里算（ISO 周、自然月、自然年），**不用 SQL 的日期函数**：
/// 那是方言相关的表达式（`YEARWEEK` / `DATE_FORMAT`），而本仓的 api_tests 走
/// MockDatabase——写错了本机全绿、一部署就现形（`SUM` 那个 DECIMAL 的坑同族）。
/// 取回原始日期列在本地分桶，与本模块其余部分保持同一种做法。
pub(super) fn period_at(g: Granularity, today: chrono::NaiveDate, back: usize) -> Period {
    use chrono::Datelike;
    let back = back as i64;
    match g {
        Granularity::Week => {
            // ISO 周：周一是第一天（`num_days_from_monday`）。
            let start = today
                - chrono::Duration::days(today.weekday().num_days_from_monday() as i64)
                - chrono::Duration::days(7 * back);
            let end = start + chrono::Duration::days(6);
            let iso = start.iso_week();
            Period {
                key: format!("{}-W{:02}", iso.year(), iso.week()),
                label: format!("{} 年第 {} 周", iso.year(), iso.week()),
                start,
                end,
            }
        }
        Granularity::Month => {
            // 先把"今天"退到本月的 1 号，再往回退 back 个月（手动进退位，
            // 不引 chrono 的 Months——那要处理 NaiveDate 溢出的 Option）。
            let mut y = today.year();
            let mut m = today.month() as i64;
            m -= back;
            while m <= 0 {
                m += 12;
                y -= 1;
            }
            let start = chrono::NaiveDate::from_ymd_opt(y, m as u32, 1).unwrap_or(today);
            let end = last_day_of_month(y, m as u32);
            Period {
                key: format!("{y}-{m:02}"),
                label: format!("{y} 年 {m} 月"),
                start,
                end,
            }
        }
        Granularity::Year => {
            let y = today.year() - back as i32;
            Period {
                key: format!("{y}"),
                label: format!("{y} 年"),
                start: chrono::NaiveDate::from_ymd_opt(y, 1, 1).unwrap_or(today),
                end: chrono::NaiveDate::from_ymd_opt(y, 12, 31).unwrap_or(today),
            }
        }
    }
}

/// 某年某月的最后一天：下个月 1 号往前退一天。闰年由 chrono 自己算，
/// **不要写 `[31,28,31,…]` 那张表**（2 月会常年差一天）。
pub(super) fn last_day_of_month(y: i32, m: u32) -> chrono::NaiveDate {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    chrono::NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .unwrap_or_else(|| chrono::NaiveDate::from_ymd_opt(y, 12, 31).unwrap_or_default())
}

#[derive(Serialize, Default)]
pub struct PeriodRow {
    /// `2026-W40` / `2026-10` / `2026`（前端做 React key 用，也是人眼可读的编号）
    pub key: String,
    pub label: String,
    /// 期界，`YYYY-MM-DD`（闭区间）
    pub start: String,
    pub end: String,
    /// **本期不是整期统计**：起始日早于 `since`（统计功能上线那天）。
    /// 前端据此把数字标成"部分"，否则"上线那一周只有两天数据"会被读成
    /// "那周流量掉了"——这正是本模块反复强调的"缺数 ≠ 零"。
    pub partial: bool,
    pub views: i64,
    pub likes: i64,
    pub favorites: i64,
    pub comments: i64,
    /// 本期**阅读量**前 5（名次口径是本期内，与全局榜无关）。
    /// 每行四个数都带——看榜的人下一个问题必然是"那篇的赞/收藏/讨论呢"。
    #[serde(rename = "topNotes")]
    pub top_notes: Vec<NoteRankRow>,
}

#[derive(Serialize, Default)]
pub struct PeriodReportDto {
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    /// 回显粒度（前端切了档之后要能对得上）
    pub kind: String,
    /// 最早有统计记录的一天；`None` = 一行记录都还没有
    pub since: Option<String>,
    /// 期列表，**倒序**（最新在前）；期界早于 `since` 的整期已被剔除
    pub periods: Vec<PeriodRow>,
}

/// GET /api/protected/stats/notes/periods?kind=week|month|year&limit=N
pub async fn note_period_report(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>,
) -> Json<ApiResponse<PeriodReportDto>> {
    let db = &state.db;

    let g = match Granularity::parse(q.get("kind").map(String::as_str).unwrap_or("week")) {
        Some(g) => g,
        None => return Json(ApiResponse::error("报表粒度只支持 week / month / year")),
    };
    // `limit` 认不出就当没给（默认值），**不是**报错：它是分页参数，
    // 拼错一个 `limit=` 不该让整个报表打不开。
    let limit = q
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| g.default_limit())
        .min(g.max_limit());

    let notes = match visible_notes(db).await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[stats] note 可见性查询失败: {e}");
            return Json(ApiResponse::error("统计查询失败，请稍后再试"));
        }
    };
    let titles: HashMap<i32, String> = notes.iter().cloned().collect();
    let ids: Vec<i32> = notes.iter().map(|(id, _)| *id).collect();

    let today = chrono::Local::now().date_naive();
    let wanted: Vec<Period> = (0..limit).map(|i| period_at(g, today, i)).collect();
    let oldest_start = wanted.last().map(|p| p.start).unwrap_or(today);

    let dto = |periods: Vec<PeriodRow>, since: Option<String>| PeriodReportDto {
        generated_at: crate::routes::stats::format_ts(chrono::Local::now().naive_local()),
        kind: g.as_str().to_string(),
        since,
        periods,
    };

    // 统计的起点 = `note_view` 最早那一行。**这是"这几期到底统没统计过"的唯一判据**：
    // 期界落在它之前的那些期，数字恒为 0，但那个 0 的意思是"功能还没上线"，
    // 不是"那几天没人看"。所以整期剔除、跨界的标 partial。
    let since: Option<chrono::NaiveDate> = match note_view::Entity::find()
        .select_only()
        .column_as(Expr::col(note_view::Column::ViewDate).min(), "d")
        .into_tuple::<Option<chrono::NaiveDate>>()
        .one(db)
        .await
    {
        Ok(v) => v.flatten(),
        Err(e) => {
            tracing::error!("[stats] note_view 起点查询失败: {e}");
            return Json(ApiResponse::error("统计查询失败，请稍后再试"));
        }
    };
    let Some(since) = since else {
        // 一行记录都没有：如实回空列表，不回一堆 0 期
        return Json(ApiResponse::success(dto(Vec::new(), None)));
    };

    let kept: Vec<Period> = wanted.into_iter().filter(|p| p.end >= since).collect();
    if kept.is_empty() {
        return Json(ApiResponse::success(dto(
            Vec::new(),
            Some(since.format("%Y-%m-%d").to_string()),
        )));
    }

    // 一篇文章在某一期里的四个数：`(期 key, note_id) → [views, likes, favorites, comments]`
    // ⚠️ 下标是**位置**约定的（0 阅读 / 1 点赞 / 2 收藏 / 3 讨论），下面累加处的
    // `[0]` / `[1usize]` / `[2usize]` / `[3usize]` 与 `or_insert([0; 4])` 必须一起看。
    type Acc = HashMap<(String, i32), [i64; 4]>;
    let mut acc: Acc = HashMap::new();
    // 期 key 的归属：日期 → 期。kept 是倒序的，构建顺序无所谓（期界互不重叠）
    let period_of = |d: chrono::NaiveDate| -> Option<String> {
        kept.iter()
            .find(|p| d >= p.start && d <= p.end)
            .map(|p| p.key.clone())
    };

    if !ids.is_empty() {
        // 阅读量：一篇文章一天一行，直接把 cnt 累进所属期
        match note_view::Entity::find()
            .select_only()
            .column(note_view::Column::NoteId)
            .column(note_view::Column::ViewDate)
            .column(note_view::Column::Cnt)
            .filter(note_view::Column::NoteId.is_in(ids.clone()))
            .filter(note_view::Column::ViewDate.gte(oldest_start))
            .into_tuple::<(i32, chrono::NaiveDate, i32)>()
            .all(db)
            .await
        {
            Ok(rows) => {
                for (id, d, c) in rows {
                    if let Some(k) = period_of(d) {
                        acc.entry((k, id)).or_insert([0; 4])[0] += c as i64;
                    }
                }
            }
            Err(e) => {
                tracing::error!("[stats] note_view 分期失败: {e}");
                return Json(ApiResponse::error("统计查询失败，请稍后再试"));
            }
        }

        let from = oldest_start.and_hms_opt(0, 0, 0).unwrap_or_default();
        // 点赞与收藏：同一条路（`created_at` 取日期），逐行累加
        let likes: Result<Vec<(i32, chrono::NaiveDateTime)>, DbErr> = note_like::Entity::find()
            .select_only()
            .column(note_like::Column::NoteId)
            .column(note_like::Column::CreatedAt)
            .filter(note_like::Column::NoteId.is_in(ids.clone()))
            .filter(note_like::Column::CreatedAt.gte(from))
            .into_tuple::<(i32, chrono::NaiveDateTime)>()
            .all(db)
            .await;
        let favs: Result<Vec<(i32, chrono::NaiveDateTime)>, DbErr> = user_favorite::Entity::find()
            .select_only()
            .column(user_favorite::Column::NoteId)
            .column(user_favorite::Column::CreatedAt)
            .filter(user_favorite::Column::NoteId.is_in(ids.clone()))
            .filter(user_favorite::Column::CreatedAt.gte(from))
            .into_tuple::<(i32, chrono::NaiveDateTime)>()
            .all(db)
            .await;
        // 讨论：与点赞/收藏同一条路（`created_at` 取日期），但**多两条过滤**
        // （公开可见的那些才算——与全局报表的 totalComments 同一口径）。
        let cmts: Result<Vec<(i32, chrono::NaiveDateTime)>, DbErr> = note_comment::Entity::find()
            .select_only()
            .column(note_comment::Column::NoteId)
            .column(note_comment::Column::CreatedAt)
            .filter(note_comment::Column::NoteId.is_in(ids.clone()))
            .filter(note_comment::Column::CreatedAt.gte(from))
            .filter(note_comment::Column::Approved.eq(1))
            .filter(note_comment::Column::IsDeleted.eq(0))
            .into_tuple::<(i32, chrono::NaiveDateTime)>()
            .all(db)
            .await;
        for (rows, slot) in [(likes, 1usize), (favs, 2usize), (cmts, 3usize)] {
            match rows {
                Ok(rows) => {
                    for (id, t) in rows {
                        if let Some(k) = period_of(t.date()) {
                            acc.entry((k, id)).or_insert([0; 4])[slot] += 1;
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("[stats] 分期点赞/收藏/讨论失败: {e}");
                    return Json(ApiResponse::error("统计查询失败，请稍后再试"));
                }
            }
        }
    }

    // 定稿：逐期算总量与榜。
    // ⚠️ 总量**不是** `top_notes` 的和——榜截断到 5 条，那一和只等于前 5 篇。
    // 总量从 `acc` 全量累加（口径与全局报表的 totalViews 一致：当前可见文章）。
    let mut periods: Vec<PeriodRow> = Vec::with_capacity(kept.len());
    for p in &kept {
        let mut rows: Vec<NoteRankRow> = Vec::new();
        let (mut tv, mut tl, mut tf, mut tc) = (0i64, 0i64, 0i64, 0i64);
        for (id, title) in titles.iter() {
            let Some(v) = acc.get(&(p.key.clone(), *id)) else {
                continue;
            };
            // 「本期一行没有」= **四个数**全是 0。判据必须随下标表一起加长：
            // 只判前三个的话，"这期只被讨论、没被阅读"的文章会进榜、且在榜上显示一串 0。
            if v == &[0, 0, 0, 0] {
                continue;
            }
            tv += v[0];
            tl += v[1];
            tf += v[2];
            tc += v[3];
            rows.push(NoteRankRow {
                note_id: *id,
                title: title.clone(),
                views: v[0],
                likes: v[1],
                favorites: v[2],
                comments: v[3],
            });
        }
        // 名次口径 = **本期阅读量**（与全局榜同一把尺子，只是范围收到这一期）；
        // 截断 5 条——展开一块能一屏看完，再多就该去全局榜看
        rows.sort_by(|a, b| b.views.cmp(&a.views).then(a.note_id.cmp(&b.note_id)));
        rows.truncate(PERIOD_TOP_N);
        periods.push(PeriodRow {
            key: p.key.clone(),
            label: p.label.clone(),
            start: p.start.format("%Y-%m-%d").to_string(),
            end: p.end.format("%Y-%m-%d").to_string(),
            partial: p.start < since,
            views: tv,
            likes: tl,
            favorites: tf,
            comments: tc,
            top_notes: rows,
        });
    }

    Json(ApiResponse::success(dto(
        periods,
        Some(since.format("%Y-%m-%d").to_string()),
    )))
}
