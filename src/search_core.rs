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

pub(crate) fn keyword_prefilter(
    cols: &[sea_orm::sea_query::SimpleExpr],
    terms: &[String],
) -> Option<sea_orm::sea_query::Condition> {
    use sea_orm::sea_query::extension::postgres::PgExpr;

    if terms.is_empty() || cols.is_empty() {
        return None;
    }
    let mut cond = sea_orm::sea_query::Condition::any();
    for t in terms {
        let pat = format!("%{}%", like_escape(t));
        for col in cols {
            cond = cond.add(col.clone().ilike(pat.clone()));
        }
    }
    Some(cond)
}

/// 命中的 term 个数（0 = 不命中；`terms.len()` = **全中**）。**档位即这个词数**——
/// 前台按「全中优先、无全中才降级到部分命中」分档（见 `routes/notes.rs::search_notes`）。
///
/// `hit` 由调用方给：文章要连**标签名字**一起判（标签在库里是 id 串，只有过了字典才知道名字），
/// 说说/留言/评论只看自己的正文（留言那张表的 `title` 列存的是**落款**，不是标题）。
pub(crate) fn count_terms(terms: &[String], hit: impl Fn(&str) -> bool) -> usize {
    terms.iter().filter(|t| hit(t)).count()
}

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

pub(crate) fn score_term_sum(
    terms: &[String],
    title: Option<&str>,
    tags: &[String],
    body: &str,
) -> i64 {
    terms.iter().map(|t| score_term(t, title, tags, body)).sum()
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

    // LIKE 转义：用户输入里的通配符必须变成字面量
    //
    // 这些只钉"转义函数"这一半；**另一半（真库真的按字面匹配）在
    // `tests/pg_integration.rs` 里**——LIKE 的语义在 SQL 里，这里证明不了它。
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
mod snippet_tests {
    use super::snippet;

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

#[cfg(test)]
mod keyword_prefilter_tests {
    use super::keyword_prefilter;
    use sea_orm::sea_query::{
        Alias, Expr, PostgresQueryBuilder, Query, SimpleExpr, Value,
    };

    fn col(name: &str) -> SimpleExpr {
        SimpleExpr::from(Expr::col(Alias::new(name.to_string())))
    }

    /// 把预筛条件塞进一条真语句里渲染出来，回 `(SQL 文本, 绑定值)`。
    fn render(cols: &[SimpleExpr], terms: &[String]) -> Option<(String, Value)> {
        let cond = keyword_prefilter(cols, terms)?;
        let (sql, values) = Query::select()
            .column(Alias::new("id"))
            .from(Alias::new("note"))
            .cond_where(cond)
            .build(PostgresQueryBuilder);
        Some((sql, values.0.into_iter().next().expect("预筛至少该有一个绑定值")))
    }

    /// **必须是 `ILIKE`**：内存判定是 `to_lowercase().contains`，而 PG 的 `LIKE`
    /// **区分大小写** ⇒ 用 `LIKE` 会把"正文写 `ESP32`、查询 `esp32`"的行静默丢掉，
    /// 而内存那一遍永远看不见被丢掉的行（这是**少结果**，不是慢）。
    ///
    /// 判据写成"`LIKE` 出现次数 == `ILIKE` 出现次数"：裸 `LIKE` 是 `ILIKE` 的子串，
    /// 单查 `contains("LIKE")` 对它**恒真**（那种写法看起来在测、其实什么都没测）。
    #[test]
    fn 预筛用_ilike_而不是_like() {
        let (sql, _) = render(&[col("title")], &["esp32".to_string()]).unwrap();
        assert!(sql.contains("ILIKE"), "预筛没生成 ILIKE：{sql}");
        assert_eq!(
            sql.matches("LIKE").count(),
            sql.matches("ILIKE").count(),
            "出现了一个裸 `LIKE`（区分大小写）—— 大小写不同的行会被静默丢掉：{sql}"
        );
    }

    /// 模式串必须是 `%<like_escape(term)>%`：`%` / `_` / `\` 三个字符都要转义成字面量。
    ///
    /// ⚠️ 这条判的是**绑定值**，不是 SQL 文本 —— sea-query 默认把值渲染成占位符
    /// （`$1`），文本里根本没有那个串；写成 `sql.contains("100\\%")` 会恒假。
    #[test]
    fn 模式串转义成字面量() {
        let cases = [
            ("100%", "%100\\%%"),
            ("a_b", "%a\\_b%"),
            ("c:\\path", "%c:\\\\path%"),
        ];
        for (term, want) in cases {
            let (_, v) = render(&[col("title")], &[term.to_string()]).unwrap();
            let Value::String(Some(pat)) = &v else {
                panic!("预筛的模式串该是字符串，实得 {v:?}");
            };
            assert_eq!(pat.as_str(), want, "term={term:?}");
        }
    }

    /// 多个 term / 多列 = 逐个组合成 `OR`（**超集**语义：任一 term 命中任一列即可）。
    #[test]
    fn 多词多列拼成_or() {
        let terms = vec!["a".to_string(), "b".to_string()];
        let (sql, _) = render(&[col("title"), col("content")], &terms).unwrap();
        assert_eq!(sql.matches("ILIKE").count(), 4, "2 个 term × 2 列：{sql}");
        assert!(
            sql.contains(" OR "),
            "term 之间必须是 OR（与 是超集的反面：会少收）：{sql}"
        );
    }

    /// 没有 term / 没有列 ⇒ `None`。**调用方不许拿它拼一个恒真条件**：
    /// `Condition::any()` 里一条都没有时渲染出来是**空**，但谁把它当成"匹配一切"去用，
    /// 就会把整张表拉进候选（预筛的意义当场归零）。
    #[test]
    fn 空输入回_none() {
        assert!(keyword_prefilter(&[], &["a".to_string()]).is_none());
        assert!(keyword_prefilter(&[col("title")], &[]).is_none());
    }
}
