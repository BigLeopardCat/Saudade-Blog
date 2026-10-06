//! 搜索的**共用纯函数**（20261006）：切词、命中判定、打分、排序分档、LIKE 转义。
//!
//! ── 为什么要单独一个模块 ───────────────────────────────────────────────
//! 站内搜索原先是「一处」（`routes/notes.rs::search_notes`，只搜文章）。20261006 用户要求
//! 把它升级成**聚合检索**（文章 / 说说 / 留言 / 评论，见 `routes/search.rs`）——于是
//! 「怎么切词」「怎么算命中」「怎么排序」这三件事立刻有了第二个消费方。
//!
//! 本仓踩过太多次"同一套规则抄了两份、后来各漂各的"（memory：*人工同步* 是主导特征）。
//! 所以这里不是"顺手抽个工具函数"，而是**把规则收成一份**：
//!   · `split_terms` / `script_runs` / `keyword_given` 从 `notes.rs` **原样搬来**（逐字未改）；
//!   · `like_escape` 原来是 `conversation.rs` 与 `upload.rs` **各一份**私有实现，
//!     第三处要用时一并收到这里（三处一份）；
//!   · `count_terms` / `score_term` / `score_term_sum` / `rank_tiered` 是把 `notes.rs` 里
//!     已有的做法**泛化**（标题 +100 / 标签 +30 / 正文次数封顶 10；全中优先的分档），
//!     **不引入新语义** —— 文章那一栏的判定与排序因此与改动前逐条一致；
//!   · `snippet`（结果行摘要）是新写的，只服务聚合搜索的展示面。
//!
//! ⚠️ 本模块**不碰** `search_notes` 的 handler 本身。那个端点同时服务 agent 的
//! `search_notes` 工具（`notes.rs` 里那条注释明写），它的行为不许因为「抽公共件」而变。
//! `notes.rs` 里留下的几个 `note_*` 助手是**转调**这里的实现，权重与判定逐字不变。

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
pub(crate) fn split_terms(kw: &str) -> Vec<String> {
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
pub(crate) fn keyword_given(kw: Option<&str>) -> bool {
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

/// MySQL LIKE 默认反斜杠转义：用户输入的字面 % _ \ 若不转义，% _ 会当通配符、
/// \ 会吞掉后续转义语义——内容搜索的用户输入注入面，须逐字符转义成 \% \_ \\。
///
/// 原先 `routes/conversation.rs`（会话/消息搜索）与 `routes/upload.rs`（图库"这张图被
/// 哪些文章引用"）各有一份私有实现；20261006 聚合搜索是**第三处**消费方，于是在此收口
/// （三处一份）。两份旧实现语义逐字等价（链式 replace 与这里的逐字符遍历结果相同）。
pub fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch == '%' || ch == '_' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// 命中的 term 个数（0 = 不命中；`terms.len()` = **全中**）。**档位即这个词数**——
/// 前台按「全中优先、无全中才降级到部分命中」分档（见 `routes/notes.rs::search_notes`）。
///
/// `hit` 由调用方给：文章要连**标签名字**一起判（标签在库里是 id 串，只有过了字典才知道名字），
/// 说说/留言/评论只看自己的正文（留言那张表的 `title` 列存的是**落款**，不是标题）。
pub(crate) fn count_terms(terms: &[String], hit: impl Fn(&str) -> bool) -> usize {
    terms.iter().filter(|t| hit(t)).count()
}

/// 关键词相关度打分（20260912，排序用）：命中标题 +100 / 命中标签 +30 /
/// 正文出现次数（上限 10，防长文堆词刷分）。确定性、可解释；不追求语义相关，够覆盖
/// 「专讲这个词的内容排在只顺带提一次的长内容之前」即可。大小写不敏感——与查询侧
/// `LIKE` 的排序规则（utf8mb4 默认 ci）一致，否则搜 "python" 时命中的标题一轮
/// 打分全 0，排序退化成按时间。
///
/// `kw_lower` 必须**已小写化**；`title` 为 `None` 表示这类内容没有标题（留言），
/// `tags` 为空切片表示这类内容没有标签维度（说说/留言/评论都传空）。
pub(crate) fn score_term(kw_lower: &str, title: Option<&str>, tags: &[String], body: &str) -> i64 {
    if kw_lower.is_empty() {
        return 0;
    }
    let mut score = 0i64;
    if title.map(|t| t.to_lowercase().contains(kw_lower)).unwrap_or(false) {
        score += 100;
    }
    if tags.iter().any(|t| t.to_lowercase().contains(kw_lower)) {
        score += 30;
    }
    score + body.to_lowercase().matches(kw_lower).count().min(10) as i64
}

/// 多词打分（20260920）：每个 term 各按 `score_term` 计分后**求和**（档内排序用）。
///
/// 不再额外加"多词全中"奖励——命中词数由调用方的**档位**承担（全中优先），
/// 档内只比"每个词命中的位置有多好"（标题 100 / 标签 30 / 正文次数）。
/// 单词查询时与旧分数完全一致。
pub(crate) fn score_term_sum(
    terms: &[String],
    title: Option<&str>,
    tags: &[String],
    body: &str,
) -> i64 {
    terms.iter().map(|t| score_term(t, title, tags, body)).sum()
}

/// 多词命中后**分档 + 排序**（20260920 引入，20261006 抽成公共件）：
///
/// **全中优先**——多词查询先只留"每个词都命中"的那些（精度优先）；一条全中的都没有时，
/// 才降级用"部分命中"（召回兜底：搜 "Docker 部署博客" 不该是一片空白）。
/// 档内按各词分项求和（+ `created_at` 兜底）排序；单词查询只有一档，等价于旧行为。
///
/// 入参每行 = `(命中词数, 分数, 时间, 载荷)`；返回载荷（调用方自己装 DTO）。
/// 文章那一栏的排序与 `search_notes` **同一条规则** —— 抽件前后逐条一致。
pub(crate) fn rank_tiered<T>(
    terms_len: usize,
    rows: Vec<(usize, i64, chrono::NaiveDateTime, T)>,
) -> Vec<T> {
    let mut all: Vec<(usize, i64, chrono::NaiveDateTime, T)> = Vec::new();
    let mut part: Vec<(usize, i64, chrono::NaiveDateTime, T)> = Vec::new();
    for row in rows {
        if row.0 == 0 {
            continue;
        }
        if row.0 == terms_len {
            all.push(row);
        } else {
            part.push(row);
        }
    }
    let mut scored = if all.is_empty() { part } else { all };
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| b.2.cmp(&a.2))
    });
    scored.into_iter().map(|(_, _, _, t)| t).collect()
}

/// 结果行摘要：空白折平（换行/多空格折叠成一个空格）后按**字符**截断。
///
/// 为什么按字符而不是字节：中文列宽按字算，按字节截会把一个字劈成 U+FFFD。
/// 为什么折平空白：这些摘要进的是搜索结果的一行两行截断槽，原文里的换行会把布局撑歪，
/// 而且头 100 个字符可能全是缩进。评论正文本来就带 `\n`（`comments::clean_content`
/// 特意留着它），留言板那篇 `talk_brief` 也为 `\r` 专门拍过平——折叠是这两条经验的收口。
pub(crate) fn snippet(s: &str, max_chars: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max_chars {
        return flat;
    }
    let mut out: String = flat.chars().take(max_chars).collect();
    out.push('…');
    out
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

#[cfg(test)]
mod like_escape_tests {
    use super::like_escape;

    // ── LIKE 转义：用户输入里的通配符必须变成字面量 ─────────────────────────
    //
    // 这些只钉"转义函数"这一半；**另一半（真库真的按字面匹配）在
    // `tests/mysql_integration.rs` 里**——LIKE 的语义在 SQL 里，这里证明不了它。
    // 两半合起来才是完整的判据。
    #[test]
    fn 转义把百分号变成字面量() {
        assert_eq!(like_escape("100%"), "100\\%");
        assert_eq!(like_escape("a%b%c"), "a\\%b\\%c");
    }

    #[test]
    fn 转义把下划线变成字面量() {
        // `_` 是 LIKE 的单字符通配符：不转义时搜 `a_b` 会命中 `aXb`
        assert_eq!(like_escape("a_b"), "a\\_b");
        assert_eq!(like_escape("__init__"), "\\_\\_init\\_\\_");
    }

    #[test]
    fn 反斜杠自己也要转义否则会吞掉后一个字符() {
        // `\%` 是"字面百分号"，所以输入里的 `\` 必须先变成 `\\`
        // —— 顺序错了（先转 % 再转 \）会把刚加上的 `\` 又转一遍，变成 `\\%`
        assert_eq!(like_escape("a\\b"), "a\\\\b");
        assert_eq!(like_escape("\\%"), "\\\\\\%");
        assert_eq!(like_escape("\\_"), "\\\\\\_");
    }

    #[test]
    fn 普通字符一个都不动() {
        assert_eq!(like_escape(""), "");
        assert_eq!(like_escape("hello world"), "hello world");
        assert_eq!(like_escape("中文也原样"), "中文也原样");
    }

    #[test]
    fn 转义只加反斜杠不改字符数() {
        // 按 char 迭代而不是按字节：多字节字符不会被劈开。
        // ⚠️ 判据**不能**写成 `out.contains("中文")`——反斜杠是插在字符**之间**的，
        // 转义之后原文本来就不再连续出现（20261004 这么红过一次）。
        let s = "中%文_字\\";
        assert_eq!(s.chars().count(), 6, "夹具写错了");
        let out = like_escape(s);
        assert_eq!(
            out.chars().count(),
            s.chars().count() + 3,
            "三个特殊字符各加一个反斜杠，其余一个不多一个不少"
        );
        for ch in s.chars() {
            assert!(out.contains(ch), "字符 {ch} 转义后不见了（多字节被劈开？）：{out}");
        }
    }
}

#[cfg(test)]
mod score_tests {
    use super::{count_terms, score_term, score_term_sum};

    /// 权重就是这三档：标题 100 / 标签 30 / 正文出现次数（**封顶 10**）。
    #[test]
    fn 打分的三档权重与正文封顶() {
        let tags = vec!["Rust".to_string()];
        // 只命中正文一次
        assert_eq!(score_term("rust", None, &[], "我用 rust 写过"), 1);
        // 命中标签 +30
        assert_eq!(score_term("rust", None, &tags, ""), 30);
        // 命中标题 +100
        assert_eq!(score_term("rust", Some("Rust 入门"), &[], ""), 100);
        // 标题 + 标签 + 正文 2 次
        assert_eq!(score_term("rust", Some("Rust 入门"), &tags, "rust rust"), 132);
        // 正文出现 30 次也只算 10（防长文堆词刷分）
        let body = "rust ".repeat(30);
        assert_eq!(score_term("rust", None, &[], &body), 10);
        // 空关键词恒 0（切完一无所剩时不该凭空给分）
        assert_eq!(score_term("", Some("Rust 入门"), &tags, "rust"), 0);
    }

    /// 多词打分 = 逐词求和；没有"全中"额外奖励（档位负责那件事）。
    #[test]
    fn 多词打分是逐词求和() {
        let terms = vec!["rust".to_string(), "入门".to_string()];
        // rust: 标题 100 + 正文 1 = 101；入门: 标题 100 = 100
        assert_eq!(score_term_sum(&terms, Some("Rust 入门"), &[], "rust"), 201);
    }

    #[test]
    fn 命中词数就是档位() {
        let terms = vec!["a".to_string(), "b".to_string()];
        assert_eq!(count_terms(&terms, |t| t == "a"), 1);
        assert_eq!(count_terms(&terms, |_| true), 2);
        assert_eq!(count_terms(&terms, |_| false), 0);
        assert_eq!(count_terms(&[], |_| true), 0);
    }
}

#[cfg(test)]
mod rank_and_snippet_tests {
    use super::{rank_tiered, snippet};
    use chrono::{NaiveDate, NaiveDateTime};

    fn at(y: i32, m: u32, d: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(0, 0, 0).unwrap()
    }

    /// **"全中优先"的本体**：第一档哪怕分数更低、时间更旧，也整体排在第二档前面。
    /// 这条红了就说明"降级到部分命中"被写反了（精度优先退化成了分数优先）。
    #[test]
    fn 全中档压过分数更高的部分命中档() {
        let rows = vec![
            // 命中 1 个词，但分数高得多、时间也新得多
            (1usize, 999i64, at(2026, 10, 1), "部分命中"),
            // 命中全部 2 个词，分数低、时间旧
            (2usize, 5i64, at(2020, 1, 1), "全中"),
        ];
        assert_eq!(rank_tiered(2, rows), vec!["全中", "部分命中"]);
    }

    /// 一条全中都没有时才降级：此时按分数、再按时间倒序。
    #[test]
    fn 没有全中时降级并按分数与时间倒序() {
        let rows = vec![
            (1usize, 10i64, at(2026, 1, 1), "分低但新"),
            (1usize, 50i64, at(2020, 1, 1), "分高但旧"),
            (1usize, 50i64, at(2026, 9, 9), "分高且新"),
        ];
        assert_eq!(rank_tiered(2, rows), vec!["分高且新", "分高但旧", "分低但新"]);
    }

    #[test]
    fn 零命中的行被丢弃() {
        let rows = vec![
            (0usize, 100i64, at(2026, 1, 1), "没命中"),
            (1usize, 1i64, at(2020, 1, 1), "命中"),
        ];
        assert_eq!(rank_tiered(1, rows), vec!["命中"]);
    }

    /// 单词查询只有一档：保住"切词前"的老行为（分数 + 时间倒序）。
    #[test]
    fn 单词查询与旧行为一致() {
        let rows = vec![
            (1usize, 0i64, at(2026, 5, 5), "同分新"),
            (1usize, 0i64, at(2026, 1, 1), "同分旧"),
        ];
        assert_eq!(rank_tiered(1, rows), vec!["同分新", "同分旧"]);
    }

    /// 摘要：折平空白 + 按**字符**截断（中文不被劈成 U+FFFD）。
    #[test]
    fn 摘要折平空白并按字符截断() {
        assert_eq!(snippet("  你好\n\n世界  ", 100), "你好 世界");
        assert_eq!(snippet(&"中".repeat(10), 4), "中中中中…");
        // 正好等于上限：不加省略号（否则"没截断"和"截断了"看起来一样）
        assert_eq!(snippet("中中中中", 4), "中中中中");
        assert_eq!(snippet("", 10), "");
    }
}
