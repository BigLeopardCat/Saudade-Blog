//! Render persisted execution receipts for subsequent chat turns.

pub(super) fn actor_prefix(row: &serde_json::Value) -> String {
    match row["principal_role"].as_str().unwrap_or("") {
        "admin" => "以管理员身份 · ".to_string(),
        "superadmin" => "以超级管理员身份 · ".to_string(),
        _ => String::new(),
    }
}

/// 变更前 → 变更后（agent 侧回执顶层 before/after，均为字符串）。
/// 任一侧缺失就只显示有的那侧；两侧都缺 → 空串（调用方自己带上"修改文章 N："）。
pub(super) fn arrow(row: &serde_json::Value) -> String {
    let before = row["before"].as_str().unwrap_or("");
    let after = row["after"].as_str().unwrap_or("");
    match (before.is_empty(), after.is_empty()) {
        (false, false) => format!("{} → {}", before, after),
        (false, true) => before.to_string(),
        (true, false) => after.to_string(),
        (true, true) => String::new(),
    }
}

pub(super) fn py_int_list(raw: &str) -> Vec<String> {
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().trim_matches(|c| c == '\'' || c == '"'))
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        .map(|s| s.to_string())
        .collect()
}

pub(super) fn render_exec_row(row: &serde_json::Value) -> String {
    let detail = match row["action"].as_str() {
        Some(a) if !a.is_empty() => a.to_string(),
        _ => legacy_exec_row(row),
    };
    let detail = format!("{}{}", actor_prefix(row), detail);
    let detail = detail.replace('[', "「").replace(']', "」");
    let digest = row["digest"].as_str().unwrap_or("");
    if digest.is_empty() {
        detail.chars().take(120).collect()
    } else {
        format!("{} — {}", detail, digest)
            .chars()
            .take(300)
            .collect()
    }
}

/// A distinct recent action: timestamp, display text and repetition count.
pub(super) type ExecRow<'a> = (String, &'a str, usize);

pub(super) fn legacy_exec_row(row: &serde_json::Value) -> String {
    let tool = row["tool"].as_str().unwrap_or("");
    let args = row["args"].as_object().cloned().unwrap_or_default();
    let arg = |k: &str| -> String {
        args.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let detail = match tool {
        "device_oled_display" => format!("屏幕显示「{}」", arg("text")),
        "navigate_to" => format!("跳转「{}」", arg("path")),
        "toggle_effect" => {
            let on = arg("action") != "off";
            format!(
                "特效「{}」已{}",
                arg("effect"),
                if on { "开" } else { "关" }
            )
        }
        "toggle_dark_mode" => format!(
            "夜间模式已{}",
            if arg("mode") == "on" { "开" } else { "关" }
        ),
        "search_notes" => format!("搜索「{}」", arg("keyword")),
        "rag_search" => format!("站内检索「{}」", arg("query")),
        "get_article_detail" => {
            let what = match arg("doc_type").as_str() {
                "board" => "留言",
                "talk" => "说说",
                "announcement" => "公告",
                _ => "文章",
            };
            match row["title"].as_str().unwrap_or("") {
                "" => format!("读取{} {}", what, arg("article_id")),
                t => format!("读取{} {}《{}》", what, arg("article_id"), t),
            }
        }
        "list_devices" => "查看设备列表".to_string(),
        "get_current_time" => "查看当前时间".to_string(),
        "list_guestbook" => "查看留言板".to_string(),
        "list_talks" => "查看说说".to_string(),
        "get_announcements" => "查看公告".to_string(),
        "list_notes" => "查看文章列表".to_string(),
        "get_blog_info" => "查看博客信息".to_string(),
        "get_social_links" => "查看社交链接".to_string(),
        "get_site_map" => "查看站点结构".to_string(),
        "get_top_notes" => "查看置顶文章".to_string(),
        "list_categories" => "查看分类".to_string(),
        "list_tags" => "查看标签".to_string(),
        "get_weather" => format!("查看天气「{}」", arg("location")),
        "get_server_status" => "查看服务器状态".to_string(),
        "get_service_health" => "查看服务健康".to_string(),
        "get_moderation_status" => "查看审核状况".to_string(),
        "get_user_stats" => "查看用户统计".to_string(),
        "list_admin_notes" => "查看后台文章列表".to_string(),
        "create_tag" => {
            let name = row["tag_name"].as_str().unwrap_or("");
            let lvl = if row["level"].as_str().unwrap_or("1") == "2" {
                "二级"
            } else {
                "一级"
            };
            if row["op"].as_str().unwrap_or("") == "tag_reuse" {
                format!("复用已有{}标签「{}」", lvl, name)
            } else {
                format!("新建{}标签「{}」", lvl, name)
            }
        }
        "update_tag" => {
            let name = row["tag_name"].as_str().unwrap_or("");
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                format!("修改标签「{}」", name)
            } else {
                format!("修改标签「{}」：{}", name, change)
            }
        }
        "delete_tag" => {
            let name = row["tag_name"].as_str().unwrap_or("");
            let lvl = if row["level"].as_str().unwrap_or("1") == "2" {
                "二级"
            } else {
                "一级"
            };
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                format!("删除{}标签「{}」", lvl, name)
            } else {
                format!("删除{}标签「{}」：{}", lvl, name, change)
            }
        }
        "create_category" => {
            format!(
                "新建分类「{}」",
                row["category_name"].as_str().unwrap_or("")
            )
        }
        "update_category" => {
            let name = row["category_name"].as_str().unwrap_or("");
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                format!("修改分类「{}」", name)
            } else {
                format!("修改分类「{}」：{}", name, change)
            }
        }
        "delete_category" => {
            let name = row["category_name"].as_str().unwrap_or("");
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                format!("删除分类「{}」", name)
            } else {
                format!("删除分类「{}」：{}", name, change)
            }
        }
        "create_announcement" => {
            format!(
                "发布公告「{}」",
                row["announcement_title"].as_str().unwrap_or("")
            )
        }
        "update_announcement" => {
            let title = row["announcement_title"].as_str().unwrap_or("");
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                format!("修改公告「{}」", title)
            } else {
                format!("修改公告「{}」：{}", title, change)
            }
        }
        "delete_announcement" => {
            format!(
                "删除公告「{}」",
                row["announcement_title"].as_str().unwrap_or("")
            )
        }
        "audit_board_comment" => {
            let id = row["board_id"].as_str().unwrap_or("");
            let who = row["board_author"].as_str().unwrap_or("");
            let change = row["change"].as_str().unwrap_or("");
            let head = if who.is_empty() {
                format!("人工复核留言 #{}", id)
            } else {
                format!("人工复核留言 #{}（{} 的留言）", id, who)
            };
            if change.is_empty() {
                head
            } else {
                format!("{}：{}", head, change)
            }
        }
        "delete_board_comment" => {
            let id = row["board_id"].as_str().unwrap_or("");
            let who = row["board_author"].as_str().unwrap_or("");
            if who.is_empty() {
                format!("删除留言 #{}", id)
            } else {
                format!("删除留言 #{}（{} 的留言）", id, who)
            }
        }
        "freeze_account" | "unfreeze_account" => {
            let verb = if tool == "freeze_account" {
                "冻结"
            } else {
                "解冻"
            };
            let name = row["account_name"].as_str().unwrap_or("");
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                format!("{}账号「{}」", verb, name)
            } else {
                format!("{}账号「{}」：{}", verb, name, change)
            }
        }
        "send_user_notice" => {
            let name = row["account_name"].as_str().unwrap_or("");
            if name.is_empty() {
                "给账号发通知".to_string()
            } else {
                format!("给账号「{}」发通知", name)
            }
        }
        "list_dashboard_todos" => "查看待办列表".to_string(),
        "create_dashboard_todo" => {
            let text = arg("text");
            let date = arg("date");
            if text.is_empty() {
                "添加待办".to_string()
            } else if date.is_empty() {
                format!("添加待办「{}」", text)
            } else {
                format!("添加待办「{}」（{}）", text, date)
            }
        }
        "complete_dashboard_todo" => {
            let text = arg("text");
            if text.is_empty() {
                "勾完成待办".to_string()
            } else {
                format!("把待办「{}」勾成完成", text)
            }
        }
        "list_my_favorites" => "查看我的收藏".to_string(),
        "get_unread_summary" => "查看未读汇总".to_string(),
        "list_notifications" => "查看站内通知".to_string(),
        "list_my_messages" => "查看站内信".to_string(),
        "add_favorite" | "remove_favorite" => {
            let id = arg("article_id");
            let change = row["change"].as_str().unwrap_or("");
            if change.is_empty() {
                if tool == "add_favorite" {
                    format!("收藏文章 {}", id)
                } else {
                    format!("取消收藏文章 {}", id)
                }
            } else {
                // 「文章 12 本来已收藏（未改动）」
                format!("文章 {} {}（未改动）", id, change)
            }
        }
        "read_notifications" => {
            let change = row["change"].as_str().unwrap_or("");
            if !change.is_empty() {
                // 「站内通知本来就没有未读的（未改动）」——同上面那条：动作词不出现。
                format!("站内通知{}（未改动）", change)
            } else {
                let want_all = matches!(arg("all").as_str(), "True" | "true" | "1");
                if want_all {
                    "标记站内通知已读（全部未读）".to_string()
                } else {
                    let ids = py_int_list(&arg("ids"));
                    match ids.len() {
                        0 => "标记站内通知已读".to_string(),
                        n if n > 3 => {
                            format!("标记站内通知已读（{} 等 {} 条）", ids[..3].join("、"), n)
                        }
                        _ => format!("标记站内通知已读（{}）", ids.join("、")),
                    }
                }
            }
        }
        "read_messages" => {
            let change = row["change"].as_str().unwrap_or("");
            if !change.is_empty() {
                // 「站内信本来就读过（未改动）」
                format!("站内信{}（未改动）", change)
            } else {
                let want_all = matches!(arg("all").as_str(), "True" | "true" | "1");
                if want_all {
                    "标记站内信已读（全部未读）".to_string()
                } else {
                    let ids = py_int_list(&arg("ids"));
                    match ids.len() {
                        0 => "标记站内信已读".to_string(),
                        n if n > 3 => {
                            format!("标记站内信已读（{} 等 {} 条）", ids[..3].join("、"), n)
                        }
                        _ => format!("标记站内信已读（{}）", ids.join("、")),
                    }
                }
            }
        }
        "set_article_status_batch" => format!(
            "批量修改文章状态：{}",
            row.get("result")
                .and_then(|value| value.as_str())
                .unwrap_or("批量操作已回执")
        ),
        "set_article_status" => format!("修改文章 {}：{}", arg("article_id"), arrow(row)),
        "set_article_tags" => format!("修改文章 {} 标签：{}", arg("article_id"), arrow(row)),
        _ => format!("操作记录({})", tool),
    };
    let detail = format!("{}{}", actor_prefix(row), detail);
    let detail = detail.replace('[', "「").replace(']', "」");
    let digest = row["digest"].as_str().unwrap_or("");
    if digest.is_empty() {
        detail.chars().take(120).collect()
    } else {
        format!("{} — {}", detail, digest)
            .chars()
            .take(300)
            .collect()
    }
}
