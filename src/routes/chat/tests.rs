use super::*;
use serde_json::json;

#[tokio::test]
async fn cancelling_stream_does_not_delete_any_persisted_turn() {
    let state = Arc::new(AppState {
        db: sea_orm::MockDatabase::new(sea_orm::DatabaseBackend::Postgres).into_connection(),
        rate_limiter: crate::rate_limiter::LoginRateLimiter::new(5, 300, 900),
        post_limiter: crate::risk::PostRateLimiter::new(),
        report_limiter: crate::rate_limiter::LoginRateLimiter::new(120, 60, 300),
    });
    let upstream = futures::stream::once(async {
        Ok(Bytes::from_static(
            b"event: text\ndata: \"partial reply\"\n\n",
        ))
    })
    .chain(futures::stream::pending());
    let mut response = Box::pin(forward_agent_stream(
        state.clone(),
        7,
        42,
        Some("user".into()),
        "fixture-task".into(),
        "cancel-test".into(),
        upstream,
    ));
    assert!(response.next().await.unwrap().is_ok());
    drop(response);
    tokio::task::yield_now().await;
    let state = Arc::try_unwrap(state)
        .ok()
        .expect("取消后没有数据库清理任务持有状态");
    assert!(
        state.db.into_transaction_log().is_empty(),
        "取消不能发出任何范围删除"
    );
}

#[tokio::test]
async fn over_budget_history_images_are_not_loaded_from_database() {
    use std::collections::BTreeMap;
    let metadata: BTreeMap<&str, sea_orm::Value> = BTreeMap::from([
        ("id", 99.into()),
        ("message_id", 42.into()),
        ("bytes", ((CHAT_HISTORY_IMAGE_BUDGET + 1) as i32).into()),
    ]);
    let db = sea_orm::MockDatabase::new(sea_orm::DatabaseBackend::Postgres)
        .append_query_results([vec![metadata]])
        .into_connection();
    let recent = vec![chat_history::Model {
        id: 42,
        user_id: 7,
        conversation_id: 1,
        role: "user".into(),
        source_role: Some("user".into()), task_id: None,
        content: "image".into(),
        created_at: chrono::Local::now().naive_local(),
    }];
    let images = load_history_images(&db, &recent).await.unwrap();
    assert!(images.is_empty());
    let log = db.into_transaction_log();
    assert_eq!(log.len(), 1, "超预算只查元数据，不发第二条大字段查询");
    let query = format!("{:?}", log[0]);
    assert!(query.contains("octet_length"));
}

#[test]
fn image_budget_fills_newest_first_and_cuts_the_rest() {
    let mb = 1024 * 1024;
    // 新→旧：3MB + 3MB 装得下；第 3 条 3MB 会越界 ⇒ 它**和更早的**都不给图
    let got = fit_image_budget(&[(30, 3 * mb), (20, 3 * mb), (10, 3 * mb), (5, 1 * mb)]);
    assert!(got.contains(&30) && got.contains(&20), "预算内的必须带上");
    assert!(!got.contains(&10), "越界的那条不给图（不是残缺数组）");
    assert!(
        !got.contains(&5),
        "比越界那条更早的也不给 —— 装填是从新到旧的单向过程"
    );
}

/// 边界：恰好等于预算**算装得下**（`>` 不是 `>=`）。这条钉的是"安全阀不要早咬一口"。
#[test]
fn image_budget_boundary_is_inclusive() {
    let mb = 1024 * 1024;
    let got = fit_image_budget(&[(1, 4 * mb), (2, 4 * mb)]);
    assert_eq!(got.len(), 2, "4+4 == 8MiB 恰好等于预算 ⇒ 两条都带");
    let got = fit_image_budget(&[(1, 4 * mb), (2, 4 * mb + 1)]);
    assert!(!got.contains(&2), "多 1 字节就越界");
}

/// 没图的消息（0 字节）**不占预算、也不中断装填** —— 否则"中间夹着一条纯文本"
/// 会把更早的图全部误杀（这是最容易写错的一种：把 0 当成"装不下"）。
#[test]
fn image_budget_skips_imageless_without_breaking_the_fill() {
    let mb = 1024 * 1024;
    let got = fit_image_budget(&[(3, 4 * mb), (2, 0), (1, 4 * mb)]);
    assert_eq!(
        got,
        [1, 3].into_iter().collect(),
        "0 字节那条跳过，后面的照装"
    );
}

#[test]
fn exec_row_prefers_python_action() {
    let row = json!({
        "tool": "create_tag",
        "args": {"title": "大笨狗"},
        // 老表会把这条渲染成「新建一级标签「」」（level 缺失时按一级、tag_name 空）
        "op": "tag_create", "level": "1", "tag_name": "",
        "action": "新建一级标签「大笨狗」",
    });
    assert_eq!(render_exec_row(&row), "新建一级标签「大笨狗」");

    // 空串 = Python 侧"这一件我没收敛"（无臂工具）⇒ 回落老表，**不许**拿空串去顶。
    let row = json!({
        "tool": "create_tag",
        "args": {"title": "大笨狗"},
        "op": "tag_create", "level": "1", "tag_name": "大笨狗", "action": "",
    });
    assert_eq!(render_exec_row(&row), "新建一级标签「大笨狗」");
}

/// `action` 是**动作句**，排版四件仍在这一侧：身份前缀贴在它前面、方括号归一、
/// 摘要拼接、列宽截断。若有人把这四件也搬去 Python，这条会红——那是刻意的：
/// 前缀依赖回执行里的 `principal_role`（审计语义），列宽依赖 detail 列定义。
#[test]
fn exec_row_still_paginates_python_action() {
    let row = json!({
        "tool": "set_article_status",
        "args": {"article_id": "12"},
        "principal_role": "admin",
        "action": "修改文章 [12]：私密 → 公开",
        "digest": "共 3 篇",
    });
    assert_eq!(
        render_exec_row(&row),
        "以管理员身份 · 修改文章 「12」：私密 → 公开 — 共 3 篇"
    );
}

#[test]
fn exec_row_create_tag_reads_toplevel_name() {
    let row = json!({
        "tool": "create_tag",
        "args": {"title": "大笨狗"},
        "op": "tag_create", "level": "1", "tag_name": "大笨狗", "tag_id": "15"
    });
    assert_eq!(render_exec_row(&row), "新建一级标签「大笨狗」");
}

#[test]
fn exec_row_create_tag_reuse_level2() {
    let row = json!({
        "tool": "create_tag",
        "args": {"title": "泠月喵"},
        "op": "tag_reuse", "level": "2", "tag_name": "泠月喵"
    });
    assert_eq!(render_exec_row(&row), "复用已有二级标签「泠月喵」");
}

/// 名字缺失（旧回执 / 提取失败）时渲染空名，但**绝不**回落去读 args["title"]
/// 或画上内部键名——args 的 title 是"请求参数"，与"实际建成的标签名"不是一回事。
#[test]
fn exec_row_create_tag_missing_name_stays_empty() {
    let row = json!({"tool": "create_tag", "args": {"title": "X"},
                         "op": "tag_create", "level": "1"});
    assert_eq!(render_exec_row(&row), "新建一级标签「」");
}

#[test]
fn exec_row_tag_update_and_delete() {
    let up = json!({"tool": "update_tag", "args": {"name": "Asyncio"},
                        "op": "update_tag", "tag_name": "编程 / Asyncio", "level": "2",
                        "change": "改名叫「异步」并移到「编程」下"});
    assert_eq!(
        render_exec_row(&up),
        "修改标签「编程 / Asyncio」：改名叫「异步」并移到「编程」下"
    );
    let del = json!({"tool": "delete_tag", "args": {"name": "小猫咪"},
                         "op": "delete_tag", "tag_name": "小猫咪", "level": "1",
                         "change": "连同 3 篇文章上的引用一起摘除"});
    assert_eq!(
        render_exec_row(&del),
        "删除一级标签「小猫咪」：连同 3 篇文章上的引用一起摘除"
    );
    // change 缺失（旧回执/生成失败）时退化成不带描述的动作行，不渲染空冒号
    let bare = json!({"tool": "delete_tag", "op": "delete_tag",
                          "tag_name": "X", "level": "2"});
    assert_eq!(render_exec_row(&bare), "删除二级标签「X」");
}

#[test]
fn exec_row_category_ops() {
    let c = json!({"tool": "create_category", "args": {"categoryTitle": "随笔"},
                       "op": "create_category", "category_name": "随笔"});
    assert_eq!(render_exec_row(&c), "新建分类「随笔」");
    let u = json!({"tool": "update_category", "op": "update_category",
                       "category_name": "随笔", "change": "改名为「杂记」"});
    assert_eq!(render_exec_row(&u), "修改分类「随笔」：改名为「杂记」");
    let d = json!({"tool": "delete_category", "op": "delete_category",
                       "category_name": "随笔", "change": "它有 4 篇文章，会变成没有分类"});
    assert_eq!(
        render_exec_row(&d),
        "删除分类「随笔」：它有 4 篇文章，会变成没有分类"
    );
}

#[test]
fn exec_row_announcement_ops() {
    let c = json!({"tool": "create_announcement",
                       "args": {"title": "维护通知", "content": "今晚 23 点维护"},
                       "op": "announcement_create", "announcement_id": "7",
                       "announcement_title": "维护通知"});
    assert_eq!(render_exec_row(&c), "发布公告「维护通知」");
    let u = json!({"tool": "update_announcement", "args": {"title": "维护通知"},
                       "op": "announcement_update", "announcement_title": "维护改期",
                       "change": "改名（原「维护通知」）"});
    assert_eq!(
        render_exec_row(&u),
        "修改公告「维护改期」：改名（原「维护通知」）"
    );
    let body = json!({"tool": "update_announcement", "args": {"title": "维护通知"},
                          "op": "announcement_update", "announcement_title": "维护通知",
                          "change": "正文已更新"});
    assert_eq!(render_exec_row(&body), "修改公告「维护通知」：正文已更新");
    // change 缺失（旧回执 / 生成失败）退化成不带描述的动作行，不渲染空冒号
    let bare = json!({"tool": "update_announcement", "op": "announcement_update",
                          "announcement_title": "维护通知"});
    assert_eq!(render_exec_row(&bare), "修改公告「维护通知」");
    let d = json!({"tool": "delete_announcement", "op": "announcement_delete",
                       "announcement_title": "维护通知"});
    assert_eq!(render_exec_row(&d), "删除公告「维护通知」");
}

#[test]
fn exec_row_board_moderation_ops() {
    let a = json!({"tool": "audit_board_comment",
                       "args": {"quote": "今天天气真好呀", "verdict": "reject"},
                       "op": "board_audit", "board_id": "12", "board_author": "路人甲",
                       "change": "待审 → 驳回"});
    assert_eq!(
        render_exec_row(&a),
        "人工复核留言 #12（路人甲 的留言）：待审 → 驳回"
    );
    let bare = json!({"tool": "audit_board_comment", "op": "board_audit",
                          "board_id": "12", "board_author": "路人甲"});
    assert_eq!(render_exec_row(&bare), "人工复核留言 #12（路人甲 的留言）");
    // 作者缺失（访客没填昵称）→ 只留 #id，不渲染空括号
    let anon = json!({"tool": "audit_board_comment", "op": "board_audit",
                          "board_id": "12", "change": "待审 → 通过"});
    assert_eq!(render_exec_row(&anon), "人工复核留言 #12：待审 → 通过");
    let d = json!({"tool": "delete_board_comment", "op": "board_delete",
                       "board_id": "12", "board_author": "路人甲", "change": "已删除"});
    assert_eq!(render_exec_row(&d), "删除留言 #12（路人甲 的留言）");
}

#[test]
fn exec_row_userdata_reads_and_writes() {
    for (tool, want) in [
        ("list_my_favorites", "查看我的收藏"),
        ("get_unread_summary", "查看未读汇总"),
        ("list_notifications", "查看站内通知"),
        ("list_my_messages", "查看站内信"),
    ] {
        let row = json!({"tool": tool, "args": {}});
        assert_eq!(render_exec_row(&row), want);
    }
    // 写三件（scope=write.own，回执不带 meta，只能从 args 渲染）；收藏行刻意
    // 不带《标题》——带了会被下一轮读成"我读过这篇"的跨轮指代证据。
    let add = json!({"tool": "add_favorite", "args": {"article_id": "12"}});
    assert_eq!(render_exec_row(&add), "收藏文章 12");
    let del = json!({"tool": "remove_favorite", "args": {"article_id": "12"}});
    assert_eq!(render_exec_row(&del), "取消收藏文章 12");
    // 全标记：Python repr 的 "True"、JSON 的 true、字符串 "1" 都认
    for raw in ["True", "true", "1"] {
        let all = json!({"tool": "read_notifications", "args": {"all": raw}});
        assert_eq!(render_exec_row(&all), "标记站内通知已读（全部未读）");
    }
    // 按 id：>3 条折叠成「前 3 等 N 条」；认不出的串不猜编号
    let three = json!({"tool": "read_notifications",
                           "args": {"all": "False", "ids": "[7, 8, 9]"}});
    assert_eq!(render_exec_row(&three), "标记站内通知已读（7、8、9）");
    let many = json!({"tool": "read_notifications",
                          "args": {"all": "False", "ids": "[7, 8, 9, 10, 11]"}});
    assert_eq!(
        render_exec_row(&many),
        "标记站内通知已读（7、8、9 等 5 条）"
    );
    let junk = json!({"tool": "read_notifications",
                          "args": {"all": "False", "ids": "['a', -3, '']"}});
    assert_eq!(render_exec_row(&junk), "标记站内通知已读");

    let m_all = json!({"tool": "read_messages", "args": {"all": "True"}});
    assert_eq!(render_exec_row(&m_all), "标记站内信已读（全部未读）");
    let m_ids = json!({"tool": "read_messages", "args": {"all": "False", "ids": "[3]"}});
    assert_eq!(render_exec_row(&m_ids), "标记站内信已读（3）");
    let m_many = json!({"tool": "read_messages",
                            "args": {"all": "False", "ids": "[3, 4, 5, 6]"}});
    assert_eq!(
        render_exec_row(&m_many),
        "标记站内信已读（3、4、5 等 4 条）"
    );
    let m_empty = json!({"tool": "read_messages", "args": {"all": "False", "ids": "[]"}});
    assert_eq!(render_exec_row(&m_empty), "标记站内信已读");
    // 与通知那三行不同字（防"复制粘贴改一半"：两臂逐字相同=有一臂漏改）
    let n_all = render_exec_row(&json!({"tool": "read_notifications",
                                            "args": {"all": "True"}}));
    assert_ne!(render_exec_row(&m_all), n_all);

    let add_noop = json!({"tool": "add_favorite", "args": {"article_id": "12"},
                              "change": "本来已收藏"});
    assert_eq!(render_exec_row(&add_noop), "文章 12 本来已收藏（未改动）");
    let del_noop = json!({"tool": "remove_favorite", "args": {"article_id": "12"},
                              "change": "本来就没收藏"});
    assert_eq!(render_exec_row(&del_noop), "文章 12 本来就没收藏（未改动）");
    let n_read = json!({"tool": "read_notifications",
                            "args": {"all": "False", "ids": "[7]"}, "change": "本来就读过"});
    assert_eq!(render_exec_row(&n_read), "站内通知本来就读过（未改动）");
    let m_read = json!({"tool": "read_messages", "args": {"all": "True"},
                            "change": "本来就没有未读的"});
    assert_eq!(render_exec_row(&m_read), "站内信本来就没有未读的（未改动）");
    // 镜像的另一半：`change` 缺席或空串（旧回执、真写路径）⇒ 照旧从 args 渲染
    // 动作词——那一行的写**真的发生了**，动作词是对的。两条分支互为镜像，谁被
    // 写反了（比如把判据写成 `contains`）都能从这一对断言看出来。
    for blank in [
        json!({"tool": "add_favorite", "args": {"article_id": "12"},
                             "change": ""}),
        json!({"tool": "add_favorite", "args": {"article_id": "12"}}),
    ] {
        assert_eq!(render_exec_row(&blank), "收藏文章 12");
    }
}

#[test]
fn py_int_list_parses_python_repr_only() {
    assert_eq!(py_int_list("[7, 8]"), vec!["7", "8"]);
    assert_eq!(py_int_list("[ 7 ,8 ]"), vec!["7", "8"]);
    assert_eq!(py_int_list("['7', \"8\"]"), vec!["7", "8"]);
    // 空 / 非数字 / 负数一律丢掉（`-3` 里的 3 也不能混进来）
    assert_eq!(py_int_list("[]"), Vec::<String>::new());
    assert_eq!(py_int_list("['a', -3]"), Vec::<String>::new());
    assert_eq!(py_int_list(""), Vec::<String>::new());
}

#[test]
fn token_jti_reads_payload_without_verifying() {
    const SYNTHETIC: &str = "eyJ2IjoyLCJ1aWQiOjEsImNvbnYiOjEsImV4cCI6MTkwMDAwMDAwMCwianRpIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEiLCJza2lsbCI6ImZhdm9yaXRlX2FkZCIsInNwZWNzIjpbeyJ0b29sIjoiYWRkX2Zhdm9yaXRlIiwiYXJncyI6eyJhcnRpY2xlX2lkIjoxMn19XX0.FAKE-SIG";
    assert_eq!(token_jti(SYNTHETIC), "00000000000000000000000000000001");
    // 形状不对一律空串（空串 = 不核销 = 放行，见 claim_confirm_token）：
    // 没有点号 / 多一段 / 非 base64url 字符 / payload 不是 JSON / 没有 jti 字段
    assert_eq!(token_jti(""), "");
    assert_eq!(token_jti("只有一段没有点号"), "");
    assert_eq!(token_jti("a.b.c"), "");
    assert_eq!(token_jti("!!**.sig"), "");
    assert_eq!(token_jti("bm90LWpzb24.sig"), ""); // "not-json"
    assert_eq!(token_jti("eyJ2IjoxfQ.sig"), ""); // {"v":1} 旧令牌没有 jti
                                                 // 不验签是**故意**的（认领是自伤型的，真凭据在 agent 侧）：签名段随便换一个
                                                 // 都照样解得出 jti——这条断言把"这是解码不是验证"写死，免得将来有人误以为
                                                 // 这里已经有了一层校验
    let tampered = format!("{}.AAAA", SYNTHETIC.split('.').next().unwrap());
    assert_eq!(token_jti(&tampered), "00000000000000000000000000000001");
}

#[test]
fn b64url_decode_handles_agent_encoding() {
    // 无填充、url-safe 字母表（`-`/`_`）；带 '=' 的变体也认（容忍，不改变结果）
    assert_eq!(b64url_decode("eyJ2IjoxfQ").unwrap(), br#"{"v":1}"#.to_vec());
    assert_eq!(
        b64url_decode("eyJ2IjoxfQ==").unwrap(),
        br#"{"v":1}"#.to_vec()
    );
    assert_eq!(b64url_decode("").unwrap(), Vec::<u8>::new());
    assert!(b64url_decode("中文").is_none());
}

/// `__PENDING__:` 帧的字段读取：缺字段/类型不对一律空串，绝不 panic
/// （帧由 agent 拼、字段名是跨语言契约——认不出就少说，不能整轮报错）。
#[test]
fn pending_frame_json_capped_is_str_only() {
    let v = json!({"task_id": "pa_20260923_000000001", "skill": "board_audit",
                       "n": 7, "nil": null, "arr": [1, 2]});
    assert_eq!(json_capped(&v, "task_id", 64), "pa_20260923_000000001");
    assert_eq!(json_capped(&v, "skill", 4), "boar");
    assert_eq!(json_capped(&v, "missing", 64), "");
    assert_eq!(json_capped(&v, "n", 64), "");
    assert_eq!(json_capped(&v, "nil", 64), "");
    assert_eq!(json_capped(&v, "arr", 64), "");
    // 截断按字符（`chars().take()`），不是字节切片
    assert_eq!(json_capped(&json!({"t": "标签名"}), "t", 2), "标签");
}

async fn body_of(r: Response) -> String {
    let bytes = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

fn early(status: StatusCode, reply: &str, success: bool, error: Option<&str>) -> Response {
    early_exit_response(
        status,
        ChatResponse {
            reply: reply.into(),
            success,
            error: error.map(Into::into),
        },
        "test",
    )
}

#[tokio::test]
async fn early_exit_is_sse_not_json() {
    let r = early(StatusCode::OK, "", false, Some("服务这边暂时联系不上"));
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(
        r.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/event-stream"
    );
    // 与正常路径同口径：不告知 nginx 就会把这唯一一帧也攒着
    assert_eq!(r.headers().get("x-accel-buffering").unwrap(), "no");
    assert_eq!(
        body_of(r).await,
        "event: error\ndata: \"服务这边暂时联系不上\"\n\n"
    );
}

/// 有正文的早退（访客合规告知）：**当一条普通回复发出去**再正常终止，
/// 而不是丢掉正文只喊一声错了——那段文案是写给访客看的全部内容。
#[tokio::test]
async fn early_exit_with_reply_becomes_a_normal_answer() {
    let r = early(StatusCode::OK, "尊敬的访客：…", true, None);
    let body = body_of(r).await;
    assert_eq!(
        body,
        "event: text\ndata: \"尊敬的访客：…\"\n\nevent: done\ndata: {}\n\n"
    );
}

/// 没有原因也不能发出一个空载荷的 `__ERROR__` 帧——
#[tokio::test]
async fn early_exit_never_sends_an_empty_error_frame() {
    let body = body_of(early(StatusCode::OK, "", false, Some("   "))).await;
    assert!(body.starts_with("event: error\ndata: \""), "{body}");
    assert!(
        body.len() > "event: error\ndata: \"\"\n\n".len(),
        "兜底话术不得为空：{body}"
    );
}

/// **两条例外必须原地不动**：前端按状态码特判它们（还原输入 / 结算确认卡），
/// 改成 SSE 帧等于把那两段打成死代码。
#[tokio::test]
async fn early_exit_keeps_status_code_exceptions_as_json() {
    for (st, code) in [
        (StatusCode::NOT_FOUND, "conversation_not_found"),
        (StatusCode::CONFLICT, "confirm_already_used"),
    ] {
        let r = early(st, "", false, Some(code));
        assert_eq!(r.status(), st);
        assert_eq!(
            r.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert!(body_of(r).await.contains(code));
    }
}

/// 载荷形态守卫：每一帧都以 `data: ` 开头、以空行分隔——**这正是前端切帧的判据**
/// （`buf.indexOf('\n\n')`）。JSON body 一个 `\n\n` 都没有，所以旧形态必然零帧。
#[tokio::test]
async fn early_exit_body_is_splittable_into_sse_frames() {
    let body = body_of(early(StatusCode::OK, "半句话", true, None)).await;
    let frames: Vec<&str> = body.trim_end_matches("\n\n").split("\n\n").collect();
    assert!(!frames.is_empty());
    for f in &frames {
        assert!(f.starts_with("event: "), "帧不以 data: 开头：{f:?}");
    }
    assert_eq!(
        frames.last(),
        Some(&"event: done\ndata: {}"),
        "最后一帧必须是终止帧"
    );
}
