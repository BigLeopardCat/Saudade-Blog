use axum::{Json, extract::{State, Query, Path}, http::StatusCode, response::{IntoResponse, Response}};
use sea_orm::{EntityTrait, ColumnTrait, QueryFilter, QueryOrder, Condition, ActiveModelTrait, Set, PaginatorTrait, ActiveValue::NotSet};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use crate::entity::{note, category, tag_one, tag_two};
use crate::routes::AppState;
use crate::utils::ApiResponse;

#[derive(Deserialize)]
pub struct NoteQuery {
    pub category_id: Option<i32>,
    pub page: Option<u64>,
    // 前端传 camelCase `pageSize`（apis/NoteMethods.tsx），Times 归档页传 `page_size`（123 行）。
    // 逐字段 rename + alias 让两种拼写都成立——注意**不要**图省事写 rename_all = "camelCase"，
    // 那会把 category_id 一起改名，直接打断分类页/归档页的按分类过滤。
    #[serde(rename = "pageSize", alias = "page_size")]
    pub page_size: Option<u64>,
}

#[derive(Serialize)]
pub struct NoteDto {
    #[serde(rename = "noteKey")]
    pub id: i32,
    #[serde(rename = "key")]
    pub key: i32, 

    #[serde(rename = "noteTitle")]
    pub title: String,
    
    #[serde(rename = "noteContent")]
    pub content: String,
    #[serde(rename = "content")] 
    pub content_raw: String, 
    
    #[serde(rename = "description")]
    pub description: String,
    #[serde(rename = "cover")]
    pub cover: String,
    // 封面裁剪参数（焦点归一化坐标 + 额外缩放），null = 未设置
    #[serde(rename = "coverFocusX")]
    pub cover_focus_x: Option<f64>,
    #[serde(rename = "coverFocusY")]
    pub cover_focus_y: Option<f64>,
    #[serde(rename = "coverZoom")]
    pub cover_zoom: Option<f64>,
    // 置顶轮播专用裁剪参数，null = 未设置（前端渲染时回退跟随 cover_* 那套）
    #[serde(rename = "carouselFocusX")]
    pub carousel_focus_x: Option<f64>,
    #[serde(rename = "carouselFocusY")]
    pub carousel_focus_y: Option<f64>,
    #[serde(rename = "carouselZoom")]
    pub carousel_zoom: Option<f64>,

    #[serde(rename = "createTime")]
    pub created_at: String,
    #[serde(rename = "updateTime")]
    pub updated_at: String,
    
    #[serde(rename = "isTop")]
    pub is_top: i32,
    pub status: String,
    // 编辑修改稿链接：Some(原文章 id) = 本行是那篇文章的自动保存修改稿（列表里带「修改稿」标记）
    #[serde(rename = "draftOf")]
    pub draft_of: Option<i32>,

    // Corrected fields for frontend compatibility
    #[serde(rename = "noteCategory")]
    pub category_id: Option<i32>, 
    #[serde(rename = "categoryTitle")]
    pub category_title: Option<String>,
    
    pub is_public: bool,
    #[serde(rename = "noteTags")]
    pub tags: String,

    // ── 卡片上的三个数（20260930，见 `note_stats::counts_for`）────────────────────
    // **`None` 时整个键不出现在 JSON 里**（不是 `null`）：这是刻意的，因为只有列表接口
    // 会挂数，详情接口不挂——`get_article_detail`（看板娘读文章详情）那条路因此**一个
    // 字节都没变**，跨仓契约不受影响。
    //
    // `None` = 这一路没有（或取不到）计数 ⇒ 卡片不渲染那一排；`Some(0)` = 挂了数且真的是
    // 0 ⇒ 显示 0。**"读不到"与"真的是 0"必须分得开**，否则统计接口一挂，站上每篇文章
    // 都会谎报"0 阅读"。
    #[serde(rename = "views", skip_serializing_if = "Option::is_none")]
    pub views: Option<i64>,
    #[serde(rename = "likes", skip_serializing_if = "Option::is_none")]
    pub likes: Option<i64>,
    #[serde(rename = "favorites", skip_serializing_if = "Option::is_none")]
    pub favorites: Option<i64>,
}

/// 封面裁剪参数兜底：焦点归一化到 0..1，缩放夹在 1..4；NaN/inf 等脏值退回默认。
fn clamp01(v: f64) -> f64 {
    if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.5 }
}

fn clamp_zoom(v: f64) -> f64 {
    if v.is_finite() { v.clamp(1.0, 4.0) } else { 1.0 }
}

fn map_note(n: note::Model, cat: Option<category::Model>) -> NoteDto {
    let cat_id = cat.as_ref().map(|c| c.id);
    let cat_name = cat.map(|c| c.name);
    
    NoteDto {
        id: n.id,
        key: n.id,
        title: n.title,
        content: n.content.clone(),
        content_raw: n.content,
        description: n.description.unwrap_or_default(),
        cover: n.cover.unwrap_or_default(),
        cover_focus_x: n.cover_focus_x,
        cover_focus_y: n.cover_focus_y,
        cover_zoom: n.cover_zoom,
        carousel_focus_x: n.carousel_focus_x,
        carousel_focus_y: n.carousel_focus_y,
        carousel_zoom: n.carousel_zoom,
        created_at: n.created_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        updated_at: n.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        is_top: n.is_top.unwrap_or(0),
        status: n.status.unwrap_or("published".to_string()),
        draft_of: n.draft_of,
        category_id: cat_id,
        category_title: cat_name,
        is_public: n.is_public,
        tags: n.tags.unwrap_or_default(),
        // 三个数一律留空：挂数是**列表接口**的事（`attach_stats`），详情接口不挂。
        // 想给详情接口也带数请先读 `note_stats` 模块头注——那条路被看板娘频繁读取。
        views: None,
        likes: None,
        favorites: None,
    }
}

pub async fn list_public_notes(
    State(state): State<Arc<AppState>>,
    Query(query): Query<NoteQuery>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    let mut condition = Condition::all();

    if let Some(cat_id) = query.category_id {
        condition = condition.add(note::Column::CategoryId.eq(cat_id));
    }

    // STRICT FILTER FOR PUBLIC API
    condition = condition.add(note::Column::IsPublic.eq(true));
    condition = condition.add(note::Column::Status.ne("draft"));

    // PAGINATION LOGIC
    // page.max(1)：page=0 时 `page - 1` 会 u64 下溢（release 环绕成 u64::MAX → 静默空页）。
    // page_size 夹到 1..1000：0 会让 sea-orm paginator panic（`page_size should not be zero`，
    // 公网无鉴权接口可被任意触发，logs/rust.log 有实证）；上限留 1000 是因为 Times 归档页
    // 用 page_size=999 一次拉全量（夹到常见分页值会让归档静默截断）。
    let page = query.page.unwrap_or(1).max(1);
    let per_page = query.page_size.unwrap_or(6).clamp(1, 1000) as u64;

    let paginator = note::Entity::find()
        .filter(condition)
        .order_by_desc(note::Column::CreatedAt)
        .find_also_related(category::Entity)
        .paginate(&state.db, per_page);

    let notes = paginator
        .fetch_page(page - 1)
        .await
        .unwrap_or(vec![]);

    let mut dtos: Vec<NoteDto> = notes.into_iter().map(|(n, cat)| {
        map_note_summary(n, cat)
    }).collect();
    attach_stats(&state.db, &mut dtos).await;

    Json(ApiResponse::success(dtos))
}

// ADMIN FUNCTION: List ALL notes
pub async fn list_all_notes(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    // No filters on public/status
    // 但排除「编辑修改稿」（draft_of 非空）：它是编辑某篇文章时自动保存落下的影子行，
    // 混进「全部文章」会与它正在被编辑的那篇同标题重复一行。草稿箱 tab（search_all_notes
    // 带 status=draft）不加这个过滤，修改稿本该在那里出现。
    let notes = note::Entity::find()
        .filter(note::Column::DraftOf.is_null())
        .order_by_desc(note::Column::CreatedAt)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    let dtos = notes.into_iter().map(|(n, cats)| {
        map_note_summary(n, cats.into_iter().next())
    }).collect();

    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct SearchRequest {
    pub keyword: Option<String>,
    /// 后台列表的「文章标题」筛选。**这个字段此前根本不存在**，而结构体又没开
    /// `deny_unknown_fields` → 前端表单里的「文章标题」一直是静默空操作（填了也没用，
    /// 也不报错）。见 `search_all_notes`。
    pub title: Option<String>,
    pub categories: Option<String>,
    pub status: Option<String>,
    // NEW FILTERS ADDED
    pub is_top: Option<i32>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// 读标签字典，返回 `id → 名字`。
///
/// 一级/二级是**两张独立自增**的表，id 命名空间并不隔离（历史上还有过重号），
/// 所以这里用一张 map 装两级、二级后写覆盖一级。**只用于搜索命中与 `note.tags` 的
/// id→名字解析，不要拿它建树/判层级**——那是 `tags.rs` 的 `fatherKey` 的活。
async fn load_tag_names(db: &sea_orm::DatabaseConnection) -> HashMap<i32, String> {
    let mut map: HashMap<i32, String> = HashMap::new();
    if let Ok(rows) = tag_one::Entity::find().all(db).await {
        for r in rows {
            map.insert(r.id, r.name);
        }
    }
    if let Ok(rows) = tag_two::Entity::find().all(db).await {
        for r in rows {
            map.insert(r.id, r.name);
        }
    }
    map
}

/// 把 `note.tags`（逗号分隔的标签 **id** 串）解析成标签 **名字** 列表（去重、丢掉查不到的 id）。
///
/// 这是本文件里「标签能不能被搜索命中」的唯一正路：库里存的是 id，搜索框里打的是名字，
/// 中间必须过一遍字典。
fn note_tag_names(tags: Option<&str>, dict: &HashMap<i32, String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for piece in tags.unwrap_or("").split(',') {
        if let Ok(id) = piece.trim().parse::<i32>() {
            if let Some(name) = dict.get(&id) {
                if !out.iter().any(|x| x == name) {
                    out.push(name.clone());
                }
            }
        }
    }
    out
}

/// 关键词是否命中这篇文章：标题 / 正文 / **标签名字**。`kw` 必须已小写化。
fn note_hits_keyword(n: &note::Model, kw: &str, tag_names: &[String]) -> bool {
    n.title.to_lowercase().contains(kw)
        || n.content.to_lowercase().contains(kw)
        || tag_names.iter().any(|t| t.to_lowercase().contains(kw))
}

/// 关键词切词（20260920）：按 Unicode 空白切（含全角空格），小写化、保序去重。
///
/// 为什么必须切：命中判定是**整串子串匹配**，用户口语里的多词查询一带空格就 0 命中。
/// 实测（线上）：`search_notes("ESP32-S3 OBC")` → []（文章《ESP32-S3-OBC固件接入参考》
/// 标题里没有这个空格形态），而 `"OBC"` / `"固件接入"` / `"ESP32-S3"` 都能命中它——
/// agent 于是如实回答"站内没有这篇"（**假否定**，用户看得见）。
///
/// 丢弃长度 1 且非 ASCII 字母数字的 term：中文单字/标点（"的/了/是"）无语义判别力，
/// 留着会把整库拉进候选。单词查询（无空白）走同一路径，行为与切词前一致。
///
/// 另有一条与之同源的规则：**整段一个字母数字都没有的 term 也丢**（`。。。` / `...` / emoji）
/// ——长度规则只管住单字符，`。。。` 是三个字符、长度规则放它过去，"纯标点切完一个 term 都不剩"
/// 这条保证因此在 3 字符以上落空（20260923 CI 质量闸抓出：`split_terms_tests` 里那条断言
/// 从写下起就没真跑过——此前 CI 只 `cargo build`，`#[cfg(test)]` 从不编译）。
///
/// **二次切分（20260921）**：空白切完还要在同一段内按**脚本类别**再切一次（见 `script_runs`）
/// ——中文和 ASCII 混排是用户口语的常态，`search_notes("ESP32固件")` 这种整串在标题里
/// 并不连续出现（标题是《ESP32-S3-OBC固件接入参考》），不切就是**假否定**（agent 如实回答
/// "站内没有这篇"）。切完仍走「档位」判定（全部 term 命中才算全中），严格度不降。
///
/// 长度规则对**单字符段**收紧了一格：只保留"整段查询本身就只有一个字符"的情形
/// （用户就打了 `1` / `a`）。混排切出来的单字符残片（`第1章` 里的 `1`）一律丢弃——
/// 那是切分副产品，留着会让 `第1章` 退化成"搜所有含数字 1 的文章"。
///
/// 注意"切完一个 term 都不剩"（`第1章` / 纯标点）与"没给关键词"是**两回事**：
/// 前者必须回空结果，调用方用 `keyword_given` 区分（否则会落进"无关键词 → 返回整表"
/// 的分支，搜 `第1章` 得到全站列表——那是假命中，与切词前那类假否定是同一处代码的两面）。
fn split_terms(kw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for piece in kw.split_whitespace() {
        let piece = piece.to_lowercase();
        let whole_piece = piece.chars().count() == 1;
        for t in script_runs(&piece) {
            // 纯符号段（`。。。` / `...` / `!!!` / emoji）一律丢：这类 term 没有任何判别力，
            // 留着就是把"搜所有含这三个点的文章"当成一次真检索。判据是**整段一个字母数字都没有**，
            // 而不是"含标点就丢"——`C++` / `ESP32-S3` / `node.js` / `3.5` 里的标点是词的一部分
            // （见 script_runs），它们各有字母数字，照常保留。
            if !t.chars().any(|c| c.is_alphanumeric()) {
                continue;
            }
            if t.chars().count() < 2 && !(whole_piece && t.chars().all(|c| c.is_ascii_alphanumeric())) {
                continue;
            }
            if !out.iter().any(|x| x == &t) {
                out.push(t);
            }
        }
    }
    out
}

/// 用户**是否给了**关键词（`None` / 空串 / 全空白 = 没给，其余 = 给了）。
///
/// 存在的理由：`split_terms` 可能把一个**非空**关键词切成一无所有（`第1章`、纯标点），
/// 而两个搜索处理函数都把"terms 为空"当作"没有关键词"、直接返回整表——于是这类查询
/// 会得到全站文章列表。这是**假命中**，必须用本函数把它和"真的没给关键词"分开。
fn keyword_given(kw: Option<&str>) -> bool {
    kw.map(|k| !k.trim().is_empty()).unwrap_or(false)
}

/// 一段文本按**脚本类别**切成连续段：ASCII 字符算一类，其余（汉字 / 全角标点 / 假名 / emoji）算另一类。
/// 纯 ASCII 段或纯非 ASCII 段切出来仍是它自己（二次切分对它们零影响）。
///
/// 为什么按类别切、而不是"凡非字母数字都当分隔符"：`C++` / `ESP32-S3` / `node.js` 里的
/// `+ - .` 是词的一部分，按标点切会把它们剁成单字符残片，其中 `c` 会命中几乎整个库。
/// **只有跨脚本才切**。
fn script_runs(piece: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut cur_is_ascii: Option<bool> = None;
    for ch in piece.chars() {
        let is_ascii = ch.is_ascii();
        if let Some(prev) = cur_is_ascii {
            if prev != is_ascii {
                out.push(std::mem::take(&mut cur));
                cur_is_ascii = Some(is_ascii);
            }
        } else {
            cur_is_ascii = Some(is_ascii);
        }
        cur.push(ch);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// 命中的 term 个数（0 = 不命中；`terms.len()` = 全中）。**档位即这个词数**——
/// 前台按「全中优先、无全中才降级到部分命中」分档（见 search_notes）。
fn term_hit_count(n: &note::Model, terms: &[String], tag_names: &[String]) -> usize {
    terms.iter().filter(|t| note_hits_keyword(n, t, tag_names)).count()
}

/// 多词命中：任一 term 命中即算（后台筛选用——召回优先，后台列表自己排序）。
fn note_hits_terms(n: &note::Model, terms: &[String], tag_names: &[String]) -> bool {
    term_hit_count(n, terms, tag_names) > 0
}

/// 关键词相关度打分（20260912，search_notes 排序用）：命中标题 +100 / 命中标签 +30 /
/// 正文出现次数（上限 10，防长文堆词刷分）。确定性、可解释；不追求语义相关，够覆盖
/// 「专讲这个词的文章排在只顺带提一次的长文之前」即可。大小写不敏感——与查询侧
/// `LIKE` 的排序规则（utf8mb4 默认 ci）一致，否则搜 "python" 时命中的标题一轮
/// 打分全 0，排序退化成按时间。
///
/// `tag_names` 是该文标签的**名字**（由 `note_tag_names` 过字典得到）。旧版这里直接拿
/// `note.tags` 的 id 串 `contains(kw)`：搜标签名永远 0 分，搜纯数字（"1"）却被
/// id 1/10/21 全部加成 +30 —— 这就是「按相关度排序」里那部分假信号。
fn search_score(note: &note::Model, kw: &str, tag_names: &[String]) -> i64 {
    let kw = kw.to_lowercase();
    if kw.is_empty() {
        return 0;
    }
    let mut score = 0i64;
    if note.title.to_lowercase().contains(&kw) {
        score += 100;
    }
    if tag_names.iter().any(|t| t.to_lowercase().contains(&kw)) {
        score += 30;
    }
    score + note.content.to_lowercase().matches(&kw).count().min(10) as i64
}

/// 多词打分（20260920）：每个 term 各按 `search_score` 计分后**求和**（档内排序用）。
///
/// 不再额外加"多词全中"奖励——命中词数由调用方的**档位**承担（全中优先），
/// 档内只比"每个词命中的位置有多好"（标题 100 / 标签 30 / 正文次数）。
/// 单词查询时与旧分数完全一致。
fn search_score_terms(note: &note::Model, terms: &[String], tag_names: &[String]) -> i64 {
    terms.iter().map(|t| search_score(note, t, tag_names)).sum()
}

pub async fn search_notes(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SearchRequest>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    let mut condition = Condition::all();

    // PUBLIC SAFEGUARDS
    condition = condition.add(note::Column::IsPublic.eq(true));
    condition = condition.add(note::Column::Status.ne("draft"));

    // 关键词**故意不做 SQL 侧过滤**（原来这里是 Title/Content/Tags 三个 LIKE 的 OR）。
    // `note.tags` 存的是逗号分隔的标签 **id**，SQL 只能对 id 串做 `LIKE '%关键词%'`：
    //   ① 搜标签名永远命中不到（库里根本没有名字）；
    //   ② 搜纯数字（"1"）会假命中所有含 id 1 / 10 / 21 的文章。
    // 标签名字必须先过字典才知道，只能在内存里判 —— 见下方命中+打分那一遍。
    // 代价是关键词不再走 SQL 谓词、本端点全量加载；这个端点本来就没有分页
    // （`list_public_notes` 同样 `.all()`），文章量小，不值得为此留着错谓词。
    if let Some(ref t) = payload.title {
        let t = t.trim();
        if !t.is_empty() {
            condition = condition.add(note::Column::Title.contains(t));
        }
    }

     if let Some(ref cat_name) = payload.categories {
        let cat_model = category::Entity::find()
            .filter(category::Column::Name.eq(cat_name))
            .one(&state.db)
            .await
            .unwrap_or(None);
            
        if let Some(c) = cat_model {
            condition = condition.add(note::Column::CategoryId.eq(c.id));
        } else {
             return Json(ApiResponse::success(vec![]));
        }
    }
    
    // Public search likely doesn't need detailed time/top status filters, but no harm logic-wise. 
    // They are omitted here for simplicity and focus on keyword search.

    let notes = note::Entity::find()
        .filter(condition)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    // 关键词命中筛选 + 相关度排序（20260912 引入排序 / 20260919 把命中判定也收进来）。
    //
    // 排序的来由：本查询此前**无 ORDER BY**，返回顺序即存储顺序（实测主键升序）——于是搜索
    // 「架构」的第一条是《Git从入门到入土》（它只在正文表格里顺带出现过一次该词），而真正讲
    // 架构的那篇紧随其后。agent 侧 search_notes 取候选[0] 时因此读错文章（9/8 跑题事故的
    // 供给端根因）。同分按 created_at 倒序（新的在前，与 list_public_notes 一致）。
    //
    // 命中判定为什么搬到这里：见上面「关键词故意不做 SQL 侧过滤」的说明——标签是 id 串，
    // 只有过一遍字典才知道名字。一遍遍历同时完成判定与打分（正文全量扫描不必做两次）。
    // 注：本端点同时服务博客前端搜索（NoteMethods.tsx）与 agent 的 search_notes，
    // 改动影响结果集（数字关键词不再假命中、标签名开始能搜到）与顺序，不影响 DTO。
    let dict = load_tag_names(&state.db).await;
    // 切成 terms 后逐词判定（20260920，见 split_terms：整串子串匹配对多词查询是假否定）；
    // 空关键词（缺省/全空白）走原来的整表返回。
    let terms = payload
        .keyword
        .as_deref()
        .map(split_terms)
        .unwrap_or_default();
    // 给了关键词却切不出任何可用 term（`第1章` / 纯标点）→ 回空，**不要**落到下面的
    // "无关键词 → 返回整表"（那会把"站内没有这种东西"答成全站文章列表，见 keyword_given）。
    if keyword_given(payload.keyword.as_deref()) && terms.is_empty() {
        return Json(ApiResponse::success(vec![]));
    }

    // 命中分档（20260920）：**全中优先**——多词查询先只留"每个词都命中"的文章（精度优先，
    // 与切词前的严格度同源，agent 不会因为降级候选读到跑题文章）；一篇全中的都没有时，
    // 才降级用"部分命中"（召回兜底：搜 "Docker 部署博客" 不该是一片空白）。
    // 档内按各词分项求和（+ created_at 兜底）排序；单词查询只有一档，等价于旧行为。
    let notes = if terms.is_empty() {
        notes
    } else {
        let mut all: Vec<(usize, i64, (note::Model, Vec<category::Model>))> = Vec::new();
        let mut part: Vec<(usize, i64, (note::Model, Vec<category::Model>))> = Vec::new();
        for r in notes {
            let names = note_tag_names(r.0.tags.as_deref(), &dict);
            let hit = term_hit_count(&r.0, &terms, &names);
            if hit == 0 {
                continue;
            }
            let row = (hit, search_score_terms(&r.0, &terms, &names), r);
            if hit == terms.len() {
                all.push(row);
            } else {
                part.push(row);
            }
        }
        let mut scored = if all.is_empty() { part } else { all };
        scored.sort_by(|a, b| {
            let (ha, sa, (na, _)) = a;
            let (hb, sb, (nb, _)) = b;
            hb.cmp(ha)
                .then_with(|| sb.cmp(sa))
                .then_with(|| nb.created_at.cmp(&na.created_at))
        });
        scored.into_iter().map(|(_, _, r)| r).collect()
    };

    let mut dtos: Vec<NoteDto> = notes.into_iter().map(|(n, cats)| {
        map_note_summary(n, cats.into_iter().next())
    }).collect();
    attach_stats(&state.db, &mut dtos).await;

    Json(ApiResponse::success(dtos))
}

pub async fn search_all_notes(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SearchRequest>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    let mut condition = Condition::all();

    // NO PUBLIC SAFEGUARDS (Admin Route)

    // 关键词与「文章标题」两个条件都不下 SQL：关键词的理由与 `search_notes` 完全相同
    // （标签存的是 id 串，SQL 侧搜标签名恒空、搜数字恒假命中），命中判定统一放在下面
    // 过完字典之后做。`title` 则是后台列表「文章标题」筛选的落地——这个字段以前压根不在
    // `SearchRequest` 里，前端填了也白填。
    if let Some(ref t) = payload.title {
        let t = t.trim();
        if !t.is_empty() {
            condition = condition.add(note::Column::Title.contains(t));
        }
    }

    if let Some(ref cat_name) = payload.categories {
        let cat_model = category::Entity::find()
            .filter(category::Column::Name.eq(cat_name))
            .one(&state.db)
            .await
            .unwrap_or(None);
            
        if let Some(c) = cat_model {
            condition = condition.add(note::Column::CategoryId.eq(c.id));
        } else {
             return Json(ApiResponse::success(vec![]));
        }
    }
    
    if let Some(ref s) = payload.status {
        // Allow filtering by specific status
         condition = condition.add(note::Column::Status.eq(s));
    }
    
    // NEW FILTERS
    if let Some(top) = payload.is_top {
        condition = condition.add(note::Column::IsTop.eq(top));
    }
    
    if let Some(ref start) = payload.start_date {
         if let Ok(date) = chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d") {
             let datetime = date.and_hms_opt(0, 0, 0).unwrap();
             condition = condition.add(note::Column::CreatedAt.gte(datetime));
         }
    }
    
    if let Some(ref end) = payload.end_date {
         if let Ok(date) = chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d") {
             let datetime = date.and_hms_opt(23, 59, 59).unwrap();
             condition = condition.add(note::Column::CreatedAt.lte(datetime));
         }
    }

    let notes = note::Entity::find()
        .filter(condition)
        // 后台列表要有确定顺序：本查询此前**无 ORDER BY**（返回顺序即存储顺序），而前端把
        // 它整份装进 antd Table 做本地分页 —— 顺序不稳意味着同一篇文章可能在第 2 页和第 3 页
        // 各出现一次、另一篇谁也没见过。与 `list_all_notes` 保持同序（新的在前）。
        .order_by_desc(note::Column::CreatedAt)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    // 关键词命中：标题 / 正文 / 标签**名字**（标签 id 先过字典）。后台列表不按相关度排序
    // （它有自己的列排序/时间序），所以这里只做过滤，不打分。
    // 判定与前台同样先切词（20260920，见 split_terms）——否则后台搜"OBC 固件"是空、
    // 前台却有结果，两边对不上。
    let terms = payload
        .keyword
        .as_deref()
        .map(split_terms)
        .unwrap_or_default();
    // 同 search_notes：给了关键词却切不出 term → 空结果（后台"没有匹配的文章"是正确答复）
    let notes = if keyword_given(payload.keyword.as_deref()) && terms.is_empty() {
        vec![]
    } else if terms.is_empty() {
        notes
    } else {
        let dict = load_tag_names(&state.db).await;
        notes
            .into_iter()
            .filter(|(n, _)| {
                note_hits_terms(n, &terms, &note_tag_names(n.tags.as_deref(), &dict))
            })
            .collect()
    };

    let dtos = notes.into_iter().map(|(n, cats)| {
        map_note_summary(n, cats.into_iter().next())
    }).collect();

    Json(ApiResponse::success(dtos))
}

#[derive(Deserialize)]
pub struct UpsertNoteRequest {
    #[serde(rename = "noteTitle")]
    pub title: Option<String>, 
    #[serde(rename = "noteContent")]
    pub content: Option<String>,
    
    #[serde(rename = "noteCategory")]
    pub category_id: Option<i32>, 
    
    #[serde(rename = "isTop")]
    pub is_top: Option<i32>,
    pub status: Option<String>,
    pub description: Option<String>,
    pub cover: Option<String>,
    // 封面裁剪参数：不传则不改动该列（编辑旧文章不会误清参数）
    #[serde(rename = "coverFocusX")]
    pub cover_focus_x: Option<f64>,
    #[serde(rename = "coverFocusY")]
    pub cover_focus_y: Option<f64>,
    #[serde(rename = "coverZoom")]
    pub cover_zoom: Option<f64>,
    // 置顶轮播专用裁剪参数：同样不传则不改动该列；三列必须同进同出（渲染端按三元组原子判定，
    // 只写其中一列会让整组失效 ⇒ 写入静默不生效）
    #[serde(rename = "carouselFocusX")]
    pub carousel_focus_x: Option<f64>,
    #[serde(rename = "carouselFocusY")]
    pub carousel_focus_y: Option<f64>,
    #[serde(rename = "carouselZoom")]
    pub carousel_zoom: Option<f64>,

    #[serde(rename = "noteTags")]
    pub tags: Option<String>,
    
    pub is_public: Option<bool>, 
}

pub async fn get_top_notes(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<NoteDto>>> {
    let mut condition = Condition::all();
    condition = condition.add(note::Column::IsTop.eq(1));
    condition = condition.add(note::Column::IsPublic.eq(true));
    condition = condition.add(note::Column::Status.ne("draft"));

    let notes = note::Entity::find()
        .filter(condition)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

     let mut dtos: Vec<NoteDto> = notes.into_iter().map(|(n, cats)| {
        map_note_summary(n, cats.into_iter().next())
    }).collect();
    attach_stats(&state.db, &mut dtos).await;

    Json(ApiResponse::success(dtos))
}

pub async fn create_note(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<UpsertNoteRequest>,
) -> Json<ApiResponse<String>> {
    let title = payload.title.unwrap_or_else(|| "Untitled".to_string());
    let content = payload.content.unwrap_or_default();
    
    // Determine is_public logic
    let mut is_public = payload.is_public.unwrap_or(true);
    let status_str = payload.status.clone().unwrap_or("published".to_string());
    
    if status_str == "draft" || status_str == "private" {
        is_public = false;
    }
    
    let new_note = note::ActiveModel {
        title: Set(title),
        content: Set(content),
        is_public: Set(is_public),
        category_id: Set(payload.category_id),
        description: Set(payload.description),
        cover: Set(payload.cover),
        cover_focus_x: Set(payload.cover_focus_x.map(clamp01)),
        cover_focus_y: Set(payload.cover_focus_y.map(clamp01)),
        cover_zoom: Set(payload.cover_zoom.map(clamp_zoom)),
        carousel_focus_x: Set(payload.carousel_focus_x.map(clamp01)),
        carousel_focus_y: Set(payload.carousel_focus_y.map(clamp01)),
        carousel_zoom: Set(payload.carousel_zoom.map(clamp_zoom)),
        is_top: Set(payload.is_top),
        status: Set(Some(status_str)),
        created_at: Set(chrono::Local::now().naive_local()),
        updated_at: Set(chrono::Local::now().naive_local()),
        tags: Set(payload.tags),
        ..Default::default()
    };

    match new_note.insert(&state.db).await {
        Ok(_) => Json(ApiResponse::success("Note created successfully".to_string())),
        Err(e) => Json(ApiResponse::error(&format!("Error: {}", e))),
    }
}

pub async fn update_note(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
    Json(payload): Json<UpsertNoteRequest>,
) -> Json<ApiResponse<String>> {
    // 是不是「从编辑器提交的完整发布」：编辑器一定同时带 noteTitle + noteContent。
    // 在字段被逐个 move 进 active_model 之前先判定。
    let from_editor = payload.title.is_some() || payload.content.is_some();

    let note_data = note::Entity::find_by_id(id).one(&state.db).await.unwrap_or(None);

    // 被点的行本身是「修改稿」（草稿箱里直接点开修改稿再提交）→ 内容得落到它的原文章行上，
    // 否则线上会凭空多出一篇同内容的新文章、原文章永远停在旧内容。
    // 只对编辑器提交（from_editor）重定向：只发 {isTop,status} 的快速改状态仍作用于被点的那行。
    let target = match note_data {
        Some(n) if from_editor && n.draft_of.is_some() => {
            let parent_id = n.draft_of.unwrap_or_default();
            match note::Entity::find_by_id(parent_id).one(&state.db).await.unwrap_or(None) {
                Some(p) => Some(p),
                // 原文章已不存在（孤儿修改稿）→ 不重定向，当普通草稿原地保存
                None => Some(n),
            }
        }
        other => other,
    };

    if let Some(n) = target {
        let target_id = n.id;
        let mut active_model: note::ActiveModel = n.into();

        if let Some(v) = payload.title { active_model.title = Set(v); }
        if let Some(v) = payload.content { active_model.content = Set(v); }
        if let Some(v) = payload.category_id { active_model.category_id = Set(Some(v)); }
        
        if let Some(v) = payload.description { active_model.description = Set(Some(v)); }
        if let Some(v) = payload.cover { active_model.cover = Set(Some(v)); }
        if let Some(v) = payload.cover_focus_x { active_model.cover_focus_x = Set(Some(clamp01(v))); }
        if let Some(v) = payload.cover_focus_y { active_model.cover_focus_y = Set(Some(clamp01(v))); }
        if let Some(v) = payload.cover_zoom { active_model.cover_zoom = Set(Some(clamp_zoom(v))); }
        if let Some(v) = payload.carousel_focus_x { active_model.carousel_focus_x = Set(Some(clamp01(v))); }
        if let Some(v) = payload.carousel_focus_y { active_model.carousel_focus_y = Set(Some(clamp01(v))); }
        if let Some(v) = payload.carousel_zoom { active_model.carousel_zoom = Set(Some(clamp_zoom(v))); }
        if let Some(v) = payload.is_top { active_model.is_top = Set(Some(v)); }
        if let Some(v) = payload.tags { active_model.tags = Set(Some(v)); }
        
        // Handle Status and Visibility logic
        if let Some(v) = payload.status.clone() { 
            active_model.status = Set(Some(v.clone()));
            if v == "public" || v == "published" {
                 active_model.is_public = Set(true);
            } else if v == "private" || v == "draft" {
                 active_model.is_public = Set(false);
            }
        }
        
        // If explicit is_public is passed, it overrides (or cooperates)
        if let Some(v) = payload.is_public { active_model.is_public = Set(v); }
        
        // Double check consistency if status was updated
        if let Some(status_val) = payload.status {
             if status_val == "draft" || status_val == "private" {
                 active_model.is_public = Set(false);
             }
        }

        active_model.updated_at = Set(chrono::Local::now().naive_local());
        
        match active_model.update(&state.db).await {
            Ok(_) => {
                // 发布即消费掉修改稿：编辑器提交（from_editor）时原文章行已拿到最新内容，
                // 挂在它下面的修改稿就没有存在意义了，删掉免得草稿箱里留过期副本。
                // 只发 {isTop, status} 的快速改状态（updateNoteStatus）不清——那不是发布内容，
                // 清了会把用户编辑中的修改稿误删。
                if from_editor {
                    let _ = note::Entity::delete_many()
                        .filter(note::Column::DraftOf.eq(target_id))
                        .exec(&state.db)
                        .await;
                }
                Json(ApiResponse::success("Note updated successfully".to_string()))
            }
            Err(e) => Json(ApiResponse::error(&format!("Error: {}", e))),
        }
    } else {
         Json(ApiResponse::error("Note not found"))
    }
}

pub async fn delete_note(
    State(state): State<Arc<AppState>>,
    Json(keys): Json<Vec<i32>>,
) -> Json<ApiResponse<String>> {
    // 级联删修改稿：文章删了，挂它的修改稿（draft_of = 该 id）就是孤儿——草稿箱里会留一行
    // 指向不存在文章的行，点进去编辑器还会 404。先删修改稿再删本体。
    let _ = note::Entity::delete_many()
        .filter(note::Column::DraftOf.is_in(keys.clone()))
        .exec(&state.db)
        .await;

    match note::Entity::delete_many()
        .filter(note::Column::Id.is_in(keys))
        .exec(&state.db)
        .await {
        Ok(_) => Json(ApiResponse::success("Deleted".to_string())),
        Err(e) => Json(ApiResponse::error(&format!("Error: {}", e))),
    }
}

pub async fn get_note_detail(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Response {
    // 公开详情仅返回已发布文章（A4 修复：与列表/搜索接口的过滤条件一致，防枚举自增 id 读取草稿/私密文章）
    let res = note::Entity::find_by_id(id)
        .filter(note::Column::IsPublic.eq(true))
        .filter(note::Column::Status.ne("draft"))
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    let dto = res.into_iter().next().map(|(n, cats)| {
        map_note(n, cats.into_iter().next())
    });

    // 20260902：文章不存在/不可见时返回 HTTP 404（此前 200+data:null）——前端
    // ReadArticle 的 notFound 判定依赖 err.response.status===404，200+null 会让
    // 编造的文章链接（如 agent 幻觉输出的 /article/17）显示成"文章加载中"而非
    // "文章不存在"，幻觉无法被用户戳穿。
    match dto {
        Some(dto) => (StatusCode::OK, Json(ApiResponse::success(dto))).into_response(),
        None => (StatusCode::NOT_FOUND, Json(ApiResponse {
            code: 404,
            message: "文章不存在".to_string(),
            data: Option::<NoteDto>::None,
        })).into_response(),
    }
}fn map_note_summary(n: note::Model, cat: Option<category::Model>) -> NoteDto {
    let mut dto = map_note(n, cat);
    dto.content = String::new();
    dto.content_raw = String::new();
    dto
}

/// 给一批列表行挂上卡片要的三个数（阅读 / 点赞 / 收藏，查询在 `note_stats::counts_for`）。
///
/// **失败只降级、不报错**：统计查询挂了就三列留 `None`（卡片那一排不渲染），列表本身照常
/// 返回——三个数是装饰，不是"列表能不能看"的前提。这也正是 `Option` 而非 `i64` 的理由：
/// 一次查询失败绝不能变成"站上每篇文章都 0 阅读"。
///
/// 只挂在**公开列表**（首页/分类页的卡片、搜索、置顶）上；后台那两个列表不挂——那里一次
/// 可能拉上千行（Times 归档页 `page_size=999`），而这三个数的消费者只有卡片。
async fn attach_stats(db: &sea_orm::DatabaseConnection, dtos: &mut [NoteDto]) {
    let ids: Vec<i32> = dtos.iter().map(|d| d.id).collect();
    match crate::routes::note_stats::counts_for(db, &ids).await {
        Ok(counts) => {
            for dto in dtos.iter_mut() {
                if let Some(c) = counts.get(&dto.id) {
                    dto.views = Some(c.views);
                    dto.likes = Some(c.likes);
                    dto.favorites = Some(c.favorites);
                }
            }
        }
        Err(e) => tracing::warn!("[notes] 列表附带统计失败，本页三个数不显示: {e}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 编辑草稿（自动保存，20260912c）：编辑器每 2s 把正在写的内容落到草稿箱里的一行。
// 与 update_note 分开是刻意的——update_note 是「发布」语义（会改 status/is_public、
// 会消费掉修改稿），自动保存绝不能碰这些。
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct AutosaveDraftRequest {
    /// 正在编辑的文章 id；None/缺省 = 新建文章（还没落过库）→ 新建一行独立草稿
    pub id: Option<i32>,
    #[serde(rename = "noteTitle")]
    pub title: Option<String>,
    #[serde(rename = "noteContent")]
    pub content: Option<String>,
    #[serde(rename = "noteCategory")]
    pub category_id: Option<i32>,
    #[serde(rename = "isTop")]
    pub is_top: Option<i32>,
    pub description: Option<String>,
    pub cover: Option<String>,
    #[serde(rename = "coverFocusX")]
    pub cover_focus_x: Option<f64>,
    #[serde(rename = "coverFocusY")]
    pub cover_focus_y: Option<f64>,
    #[serde(rename = "coverZoom")]
    pub cover_zoom: Option<f64>,
    #[serde(rename = "carouselFocusX")]
    pub carousel_focus_x: Option<f64>,
    #[serde(rename = "carouselFocusY")]
    pub carousel_focus_y: Option<f64>,
    #[serde(rename = "carouselZoom")]
    pub carousel_zoom: Option<f64>,
    #[serde(rename = "noteTags")]
    pub tags: Option<String>,
}

#[derive(Serialize, Default)]
pub struct AutosaveDraftResult {
    /// 客户端此后继续沿用的文章 id（新建时 = 刚建出来的草稿行 id）
    pub id: i32,
    /// 本次实际写入了哪一行（原文章行 / 独立草稿行 / 修改稿行）
    #[serde(rename = "draftId")]
    pub draft_id: i32,
    /// true = 写的是「原文章的修改稿」，原文章线上内容一个字没动
    #[serde(rename = "isRevision")]
    pub is_revision: bool,
    #[serde(rename = "updateTime")]
    pub update_time: String,
}

/// 解析这次自动保存该写哪一行：
/// - `id = None`            → 新建一行独立草稿（status='draft'，进草稿箱）
/// - 目标行 status='draft'  → 原地更新（它本来就是草稿箱里的一行）
/// - 其他（public/private） → 取它的修改稿行（draft_of = id）；没有就克隆原行建一行。
///   原行在此期间**一个列都不动**，线上访客看到的仍是旧内容。
async fn resolve_autosave_target(
    state: &Arc<AppState>,
    id: Option<i32>,
) -> Result<note::Model, String> {
    let now = chrono::Local::now().naive_local();

    let Some(id) = id else {
        let row = note::ActiveModel {
            title: Set(String::new()),
            content: Set(String::new()),
            status: Set(Some("draft".to_string())),
            is_public: Set(false),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        };
        return row
            .insert(&state.db)
            .await
            .map_err(|e| format!("Create draft failed: {}", e));
    };

    let Some(n) = note::Entity::find_by_id(id).one(&state.db).await.unwrap_or(None) else {
        return Err("Note not found".to_string());
    };

    // 草稿（含新建时落下的那行）原地更新，不再套一层修改稿
    if n.status.as_deref() == Some("draft") {
        return Ok(n);
    }

    if let Some(rev) = note::Entity::find()
        .filter(note::Column::DraftOf.eq(id))
        .order_by_desc(note::Column::Id)
        .one(&state.db)
        .await
        .unwrap_or(None)
    {
        return Ok(rev);
    }

    // 克隆原行做修改稿（id 交给自增），内容随后由 payload 覆盖
    let mut am: note::ActiveModel = n.into();
    am.id = NotSet;
    am.draft_of = Set(Some(id));
    am.status = Set(Some("draft".to_string()));
    am.is_public = Set(false);
    am.created_at = Set(now);
    am.updated_at = Set(now);
    am.insert(&state.db)
        .await
        .map_err(|e| format!("Create revision failed: {}", e))
}

pub async fn autosave_note(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<AutosaveDraftRequest>,
) -> Json<ApiResponse<AutosaveDraftResult>> {
    let client_id = payload.id;

    let target = match resolve_autosave_target(&state, payload.id).await {
        Ok(t) => t,
        Err(e) => return Json(ApiResponse::error(&e)),
    };

    let is_revision = target.draft_of.is_some();
    let mut am: note::ActiveModel = target.into();

    if let Some(v) = payload.title { am.title = Set(v); }
    if let Some(v) = payload.content { am.content = Set(v); }
    if let Some(v) = payload.category_id { am.category_id = Set(Some(v)); }
    if let Some(v) = payload.description { am.description = Set(Some(v)); }
    if let Some(v) = payload.cover { am.cover = Set(Some(v)); }
    if let Some(v) = payload.cover_focus_x { am.cover_focus_x = Set(Some(clamp01(v))); }
    if let Some(v) = payload.cover_focus_y { am.cover_focus_y = Set(Some(clamp01(v))); }
    if let Some(v) = payload.cover_zoom { am.cover_zoom = Set(Some(clamp_zoom(v))); }
    if let Some(v) = payload.carousel_focus_x { am.carousel_focus_x = Set(Some(clamp01(v))); }
    if let Some(v) = payload.carousel_focus_y { am.carousel_focus_y = Set(Some(clamp01(v))); }
    if let Some(v) = payload.carousel_zoom { am.carousel_zoom = Set(Some(clamp_zoom(v))); }
    if let Some(v) = payload.is_top { am.is_top = Set(Some(v)); }
    if let Some(v) = payload.tags { am.tags = Set(Some(v)); }
    // status / is_public 一律不动：写的一定是草稿（原行是草稿，克隆出来的修改稿也是草稿），
    // 发布是 update_note 的事。
    am.updated_at = Set(chrono::Local::now().naive_local());

    match am.update(&state.db).await {
        Ok(saved) => Json(ApiResponse::success(AutosaveDraftResult {
            id: client_id.unwrap_or(saved.id),
            draft_id: saved.id,
            is_revision,
            update_time: saved.updated_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        })),
        Err(e) => Json(ApiResponse::error(&format!("Error: {}", e))),
    }
}

#[derive(Serialize)]
pub struct EditorNoteDto {
    /// 原文章行（id 就是 URL 里那个 id）
    pub note: NoteDto,
    /// 待继续编辑的修改稿；null = 没有未发布的修改稿，编辑器直接用 note 回填
    pub draft: Option<NoteDto>,
}

/// 编辑器专用的读入口：公开的 `GET /api/public/notes/:id` 会挡掉草稿/私密文章（A4），
/// 导致草稿箱点进去 404、编辑器打不开自己的草稿。这里不做可见性过滤（protected 组已限 admin）。
pub async fn get_note_for_edit(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i32>,
) -> Response {
    let rows = note::Entity::find_by_id(id)
        .find_with_related(category::Entity)
        .all(&state.db)
        .await
        .unwrap_or(vec![]);

    let Some((n, cats)) = rows.into_iter().next() else {
        return (StatusCode::NOT_FOUND, Json(ApiResponse {
            code: 404,
            message: "文章不存在".to_string(),
            data: Option::<EditorNoteDto>::None,
        })).into_response();
    };

    // 三行：(原文章, 原文章分类, 待继续编辑的修改稿)
    let (note_row, note_cats, draft_row) = match n.draft_of {
        // URL 里的 id 本身就是一行「修改稿」（草稿箱直接点开修改稿、或旧链接）：
        // 得把它的**原文章**当 note 返回——编辑器用 note 的状态回填弹窗，
        // 拿修改稿自己的 status（恒为 draft）回填会让弹窗默认「草稿」，用户不改直接提交
        // 就什么都没发布。内容仍用这行修改稿回填。发布时 update_note 做同样的重定向。
        Some(parent_id) => {
            let parents = note::Entity::find_by_id(parent_id)
                .find_with_related(category::Entity)
                .all(&state.db)
                .await
                .unwrap_or(vec![]);
            match parents.into_iter().next() {
                Some((p, pcats)) => (p, pcats, Some((n, cats))),
                // 原文章已被删（孤儿修改稿）→ 当普通草稿，至少内容还在
                None => (n, cats, None),
            }
        }
        None => {
            let drafts = note::Entity::find()
                .filter(note::Column::DraftOf.eq(id))
                .order_by_desc(note::Column::Id)
                .find_with_related(category::Entity)
                .all(&state.db)
                .await
                .unwrap_or(vec![]);
            (n, cats, drafts.into_iter().next())
        }
    };

    let dto = EditorNoteDto {
        note: map_note(note_row, note_cats.into_iter().next()),
        draft: draft_row.map(|(d, cats)| map_note(d, cats.into_iter().next())),
    };

    (StatusCode::OK, Json(ApiResponse::success(dto))).into_response()
}

#[cfg(test)]
mod split_terms_tests {
    use super::{keyword_given, split_terms};

    fn terms(kw: &str) -> Vec<String> {
        split_terms(kw)
    }

    /// 纯中文 / 纯 ASCII / 多空白段：**与二次切分前逐字一致**（不许有行为漂移）。
    #[test]
    fn unchanged_for_single_script() {
        assert_eq!(terms("架构"), vec!["架构"]);
        assert_eq!(terms("ESP32-S3 OBC"), vec!["esp32-s3", "obc"]);
        assert_eq!(terms("C++"), vec!["c++"]);
        assert_eq!(terms("node.js"), vec!["node.js"]);
        assert_eq!(terms("架构 设计"), vec!["架构", "设计"]);
        assert_eq!(terms("1"), vec!["1"]);          // 整段就是一个字符：既有行为保留
        assert_eq!(terms("a b"), vec!["a", "b"]);
        assert_eq!(terms("   "), Vec::<String>::new());
        assert_eq!(terms("的"), Vec::<String>::new()); // 单字中文无语义判别力
        assert_eq!(terms("架构架构 架构"), vec!["架构架构", "架构"]);
    }

    /// 中英混排按脚本类别切开（20260921 修的核心）：整串子串匹配对口语混排是假否定。
    #[test]
    fn splits_mixed_script() {
        assert_eq!(terms("ESP32固件"), vec!["esp32", "固件"]);
        assert_eq!(terms("ESP32-S3-OBC固件接入"), vec!["esp32-s3-obc", "固件接入"]);
        // 中间夹一个单字中文：切成三段后该单字被长度规则丢掉，剩下的正是有判别力的两词
        assert_eq!(terms("Python的asyncio"), vec!["python", "asyncio"]);
        // ASCII 标点不断词（只有跨脚本才切）——"架构-设计" 切在 `-` 上是因为它两侧是不同脚本
        assert_eq!(terms("架构-设计"), vec!["架构", "设计"]);
    }

    /// 混排切出来的**单字符残片**必须丢掉：`第1章` 若留下 `1`，就退化成"搜所有含数字 1 的文章"。
    #[test]
    fn drops_single_char_fragments_from_split() {
        assert_eq!(terms("第1章"), Vec::<String>::new());
    }

    /// 切完一无所剩的**非空**关键词必须与"没给关键词"分开：前者回空结果、
    /// 后者返回整表（分类页/文章列表就是靠后者一次拉全量）。混作一谈会让
    /// `第1章` 这类查询拿到全站文章列表（假命中）。
    #[test]
    fn keyword_given_distinguishes_blank_from_unusable() {
        assert!(keyword_given(Some("架构")));
        assert!(keyword_given(Some("  架构  ")));
        assert!(!keyword_given(Some("")));
        assert!(!keyword_given(Some("   ")));
        assert!(!keyword_given(None));
        // 非空但切不出 term：这是"给了关键词"，不是"没给"
        assert!(keyword_given(Some("第1章")) && terms("第1章").is_empty());
        assert!(keyword_given(Some("。。。")) && terms("。。。").is_empty());
    }
}
