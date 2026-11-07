use super::*;
use chrono::{Datelike, NaiveDate, NaiveDateTime};

fn d(y: i32, m: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, day).expect("夹具日期本身写错了")
}

fn dt(y: i32, m: u32, day: u32, h: u32) -> NaiveDateTime {
    d(y, m, day).and_hms_opt(h, 0, 0).expect("夹具时刻写错了")
}

// 月末：闰年不许靠查表
#[test]
fn 月末由_chrono_算闰年不查表() {
    assert_eq!(last_day_of_month(2024, 2), d(2024, 2, 29), "2024 是闰年");
    assert_eq!(last_day_of_month(2026, 2), d(2026, 2, 28), "2026 不是");
    assert_eq!(
        last_day_of_month(2000, 2),
        d(2000, 2, 29),
        "能被 400 整除是闰年"
    );
    assert_eq!(
        last_day_of_month(1900, 2),
        d(1900, 2, 28),
        "能被 100 整除非闰年"
    );
    assert_eq!(last_day_of_month(2026, 4), d(2026, 4, 30));
    assert_eq!(last_day_of_month(2026, 11), d(2026, 11, 30));
}

#[test]
fn 十二月跨年不回卷成十三月() {
    assert_eq!(last_day_of_month(2026, 12), d(2026, 12, 31));
}

#[test]
fn 相邻两期严丝合缝() {
    let today = d(2026, 10, 4);
    for g in [Granularity::Week, Granularity::Month, Granularity::Year] {
        for back in 0..4 {
            let newer = period_at(g, today, back);
            let older = period_at(g, today, back + 1);
            assert_eq!(
                older.end.succ_opt().expect("日期溢出"),
                newer.start,
                "{g:?} 的第 {back}/{} 期之间断了或叠了（{} 的末日在 {}，{} 的首日在 {}）",
                back + 1,
                older.key,
                older.end,
                newer.key,
                newer.start
            );
        }
    }
}

#[test]
fn 周期是一整周从周一到周日() {
    let today = d(2026, 10, 4);
    for back in 0..3 {
        let p = period_at(Granularity::Week, today, back);
        assert_eq!(
            p.start.weekday(),
            chrono::Weekday::Mon,
            "第 {back} 期的首日 {} 不是周一（key={}）",
            p.start,
            p.key
        );
        assert_eq!(p.end.weekday(), chrono::Weekday::Sun, "第 {back} 期");
        assert_eq!((p.end - p.start).num_days(), 6);
        let iso = p.start.iso_week();
        assert_eq!(p.key, format!("{}-W{:02}", iso.year(), iso.week()));
    }
}

#[test]
fn 跨年那一周按_iso_归属前一年() {
    let p = period_at(Granularity::Week, d(2026, 1, 1), 0);
    assert_eq!(p.start, d(2025, 12, 29), "2026-W01 的周一是 2025-12-29");
    assert_eq!(p.end, d(2026, 1, 4));
    assert_eq!(p.key, "2026-W01");
}

#[test]
fn 月期跨年要借位而不是回卷() {
    let p = period_at(Granularity::Month, d(2026, 1, 15), 1);
    assert_eq!(
        (p.key.as_str(), p.start, p.end),
        ("2025-12", d(2025, 12, 1), d(2025, 12, 31))
    );
    // 往回 13 个月 = 上一年同月（借位要连年一起动）
    let p13 = period_at(Granularity::Month, d(2026, 1, 15), 13);
    assert_eq!(p13.key, "2024-12");
    assert_eq!(p13.start, d(2024, 12, 1));
}

#[test]
fn 月期不把三月三十一号当二月末() {
    // `today - 1 个月` 那种写法在 3/31 上会滚成 3/3；这里必须退到 1 号再进月
    let p = period_at(Granularity::Month, d(2026, 3, 31), 1);
    assert_eq!(p.start, d(2026, 2, 1));
    assert_eq!(p.end, d(2026, 2, 28), "2026 年 2 月只有 28 天");
    assert_eq!(
        period_at(Granularity::Month, d(2026, 3, 31), 0).end,
        d(2026, 3, 31)
    );
}

#[test]
fn 年期是整年() {
    let p = period_at(Granularity::Year, d(2026, 10, 4), 1);
    assert_eq!(
        (p.key.as_str(), p.start, p.end),
        ("2025", d(2025, 1, 1), d(2025, 12, 31))
    );
}

// collect：NULL 折零，错误原样透传
#[test]
fn 零行折成零而不是丢掉这个_id() {
    let m = collect(Ok(vec![(1, Some(5)), (2, None)])).expect("不该报错");
    assert_eq!(m[&1], 5);
    assert_eq!(
        m[&2], 0,
        "SQL 在零行时回 NULL ⇒ 折成 0。**丢掉这个 key 是错的**：调用方靠它在场\
             区分「这篇没人看过」与「这篇的计数没查出来」"
    );
}

#[test]
fn collect_把错误原样透传() {
    let e = collect(Err(DbErr::Custom("boom".into())));
    assert!(
        e.is_err(),
        "查询失败不许折成空表——那会让报表显示成「全站零流量」"
    );
}

// rank：数值倒序、并列按 id 升序、截断到 TOP_N
fn row(id: i32, views: i64, likes: i64) -> NoteRankRow {
    NoteRankRow {
        note_id: id,
        title: format!("t{id}"),
        views,
        likes,
        favorites: 0,
        comments: 0,
    }
}

#[test]
fn 排行榜并列时按_id_升序且读数不改() {
    let metric: HashMap<i32, i64> = [(7, 1), (3, 1), (5, 9)].into_iter().collect();

    let r = rank(vec![row(7, 1, 99), row(3, 1, 0), row(5, 9, 0)], &metric);
    assert_eq!(
        r.iter().map(|x| x.note_id).collect::<Vec<_>>(),
        vec![5, 3, 7],
        "5 分最高；3 与 7 并列 ⇒ 按 id 升序（两次报表可比对）"
    );
    // 排序只按 metric 那一列，**不改行上其余的读数**
    let r7 = r.iter().find(|x| x.note_id == 7).expect("7 不在榜上");
    assert_eq!((r7.views, r7.likes), (1, 99));
}

#[test]
fn 排行榜缺项按零参与排序() {
    let rows = vec![row(1, 0, 0), row(2, 0, 0)];
    let r = rank(rows, &HashMap::new());
    assert_eq!(
        r.iter().map(|x| x.note_id).collect::<Vec<_>>(),
        vec![1, 2],
        "一个读数都没有 ⇒ 全并列 ⇒ 退回 id 升序（不是随机序）"
    );
}

#[test]
fn 排行榜截断到_top_n() {
    let rows: Vec<NoteRankRow> = (1..=25).map(|i| row(i, i as i64, 0)).collect();
    let metric: HashMap<i32, i64> = (1..=25).map(|i| (i, i as i64)).collect();
    let r = rank(rows, &metric);
    assert_eq!(r.len(), TOP_N);
    assert_eq!(r[0].note_id, 25, "最高分在最前");
    assert_eq!(r[TOP_N - 1].note_id, 16);
}

// bucket_by_day：只往窗口里已有的日子累加
#[test]
fn 分桶只落进窗口内的日子() {
    let mut daily: HashMap<NaiveDate, DailyRow> = HashMap::new();
    daily.insert(
        d(2026, 10, 1),
        DailyRow {
            date: "2026-10-01".into(),
            views: 0,
            likes: 0,
            favorites: 0,
            comments: 0,
        },
    );
    // 三条落在窗口内（同一天两条），一条落在窗口外
    let rows = vec![
        dt(2026, 10, 1, 9),
        dt(2026, 10, 1, 21),
        d(2026, 9, 30).and_hms_opt(23, 0, 0).unwrap(),
    ];
    bucket_by_day(&mut daily, rows, |r| &mut r.likes);

    assert_eq!(daily[&d(2026, 10, 1)].likes, 2, "同一天的两条要累加");
    assert_eq!(
        daily.len(),
        1,
        "窗口外的日期**不新建行**——窗口是调用方给的定长 30 格"
    );
}

// 访客标识：白名单字符集与长度
fn key_of(raw: &str) -> Option<String> {
    let mut h = HeaderMap::new();
    h.insert(VISITOR_HEADER, raw.parse().expect("头值不合规"));
    visitor_key(&h)
}

#[test]
fn 访客标识不合规一律当没有() {
    assert_eq!(visitor_key(&HeaderMap::new()), None, "头缺失");
    assert_eq!(key_of("short12"), None, "短于 8 个字符");
    assert_eq!(key_of(&"a".repeat(65)), None, "长于 64 个字符");
    assert_eq!(key_of("abcdefg;hij"), None, "分号不在白名单里");
    assert_eq!(key_of("abcdefg hij"), None, "空格不在白名单里（内部）");
    assert_eq!(key_of("abcdefg中文hij"), None, "非 ASCII 一律不收");
}

#[test]
fn 访客标识合规时原样收下并去掉首尾空白() {
    assert_eq!(key_of("abc-DEF_123"), Some("abc-DEF_123".to_string()));
    assert_eq!(
        key_of("  abcdefgh  "),
        Some("abcdefgh".to_string()),
        "先 trim 再判长度：这个标识刚够 8 位，不该被判短"
    );
    assert_eq!(
        key_of(&"a".repeat(64)),
        Some("a".repeat(64)),
        "64 位是含在内的上界"
    );
}

// 秒级截断：`Who::tag()` 只取前 8 位，而标识是纯 ASCII ⇒ 切片不会劈开多字节字符。
// 这条不是在测那个函数，是在钉住"它凭什么可以切片"这个前提。
#[test]
fn 访客标识必定是纯_ascii_因此可以按字节切() {
    let k = key_of("abcdefgh").expect("合规");
    assert!(k.is_ascii());
    assert_eq!(&k[..k.len().min(8)], "abcdefgh");
}

fn stats_state(db: sea_orm::DatabaseConnection) -> Arc<AppState> {
    Arc::new(AppState {
        db,
        rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 300, 900),
        post_limiter: crate::risk::PostRateLimiter::new(),
        report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    })
}

#[tokio::test]
async fn visible_lookup_failure_is_unavailable_and_missing_article_does_not_read_counts() {
    use sea_orm::{DatabaseBackend, DbErr, MockDatabase};
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_errors([DbErr::Custom("offline".into())])
        .into_connection();
    let response = note_stats(State(stats_state(db)), Path(19), HeaderMap::new()).await;
    assert_eq!(
        response.status(),
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    let db = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([Vec::<std::collections::BTreeMap<String, sea_orm::Value>>::new()])
        .into_connection();
    let response = note_stats(State(stats_state(db)), Path(19), HeaderMap::new()).await;
    assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn postgres_metrics_refuse_nonpublic_and_shadow_articles() {
    use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement, TransactionTrait};
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        eprintln!("SKIP article metric visibility PostgreSQL: TEST_PG_URL not set");
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let tx = db.begin().await.unwrap();
    let mut root = None;
    for (status, public, shadow, visible) in [
        ("public", true, false, true),
        ("draft", false, false, false),
        ("published", false, false, false),
        ("public", true, true, false),
    ] {
        let row=tx.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
            "INSERT INTO note(title,content,status,is_public,draft_of,created_at,updated_at) VALUES ('metric fixture','body',$1,$2,$3,localtimestamp,localtimestamp) RETURNING id",
            vec![status.into(),public.into(),if shadow {root}else{None}.into()])).await.unwrap().unwrap();
        let id: i32 = row.try_get("", "id").unwrap();
        if root.is_none() {
            root = Some(id)
        }
        assert_eq!(visible_note_id(&tx, id).await.unwrap(), visible);
    }
    tx.rollback().await.unwrap();
}
