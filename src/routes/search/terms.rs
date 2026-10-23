use jieba_rs::Jieba;
use std::sync::OnceLock;

/// Aggregate-only tokenization: article/Agent search keeps its existing contract.
/// Keep code identifiers intact; unknown Chinese runs retain a literal fallback.
pub(super) fn tokenize(keyword: &str) -> Result<Vec<String>, &'static str> {
    static JIEBA: OnceLock<Jieba> = OnceLock::new();
    let mut terms = Vec::new();
    for term in crate::search_core::split_terms(keyword) {
        let words: Vec<String> = if term.chars().all(|c| ('\u{3400}'..='\u{9fff}').contains(&c)) {
            JIEBA
                .get_or_init(Jieba::new)
                .cut(&term, false)
                .into_iter()
                .filter(|word| word.word.chars().count() >= 2)
                .map(|word| word.word.to_string())
                .collect()
        } else {
            vec![term.clone()]
        };
        for word in if words.is_empty() { vec![term] } else { words } {
            if !terms.contains(&word) {
                terms.push(word);
            }
            if terms.len() > 16 {
                return Err("搜索词过多，请缩短搜索内容");
            }
        }
    }
    Ok(terms)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chinese_compounds_match_explicit_words() {
        assert_eq!(
            tokenize("博客部署").unwrap(),
            tokenize("博客 部署").unwrap()
        );
        assert_eq!(tokenize("部署博客").unwrap(), vec!["部署", "博客"]);
        assert_eq!(
            tokenize("React博客部署").unwrap(),
            vec!["react", "博客", "部署"]
        );
    }
    #[test]
    fn preserves_identifiers_and_rejects_excess_terms() {
        assert_eq!(
            tokenize("ESP32-S3 C++ node.js 100% a_b z:\\srch").unwrap(),
            crate::search_core::split_terms("ESP32-S3 C++ node.js 100% a_b z:\\srch")
        );
        assert!(tokenize(
            &(0..17)
                .map(|n| format!("word{n}"))
                .collect::<Vec<_>>()
                .join(" ")
        )
        .is_err());
        assert!(tokenize("。。。 第1章").unwrap().is_empty());
    }
}
