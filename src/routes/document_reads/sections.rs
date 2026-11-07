//! Source-backed CommonMark sections. Offsets are Unicode code points on the original text.
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use serde::Serialize;
use std::collections::BTreeMap;

pub const SCHEMA: &str = "commonmark-top-level-source-v1";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub title: String,
    pub level: u8,
    pub path: Vec<String>,
    pub body_start: usize,
    pub body_end: usize,
    #[serde(skip)]
    pub byte_start: usize,
    #[serde(skip)]
    pub byte_end: usize,
}

pub fn outline(content: &str, title: &str) -> Vec<Section> {
    let mut headings = Vec::new();
    let mut depth = 0usize;
    let mut current: Option<(usize, usize, u8, Option<(usize, usize)>)> = None;
    for (event, range) in Parser::new(content).into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { level, .. }) if depth == 0 => {
                let line_start = content[..range.start]
                    .rfind(['\r', '\n'])
                    .map_or(0, |position| position + 1);
                current = Some((line_start, range.end, level as u8, None));
                depth += 1;
            }
            Event::End(TagEnd::Heading(_)) if depth == 1 => {
                if let Some((start, end, level, inner)) = current.take() {
                    let heading = inner
                        .map(|(mut a, b)| {
                            // Text event spans omit the leading CommonMark escape marker.
                            if a > start && content.as_bytes()[a - 1] == b'\\' {
                                a -= 1;
                            }
                            content[a..b].replace("\r\n", "\n").replace('\r', "\n")
                        })
                        .unwrap_or_default();
                    headings.push((start, end, level, heading));
                }
                depth -= 1;
            }
            event => {
                if let Some((_, _, _, inner)) = current.as_mut() {
                    *inner = Some(match inner {
                        Some((a, b)) => ((*a).min(range.start), (*b).max(range.end)),
                        None => (range.start, range.end),
                    });
                }
                match event {
                    Event::Start(_) => depth += 1,
                    Event::End(_) => depth = depth.saturating_sub(1),
                    _ => {}
                }
            }
        }
    }
    let mut positions: Vec<usize> = headings.iter().flat_map(|h| [h.0, h.1]).collect();
    positions.sort_unstable();
    positions.dedup();
    let mut positions = positions.into_iter().peekable();
    let mut offsets = BTreeMap::new();
    let mut total = 0;
    for (index, (byte, _)) in content.char_indices().enumerate() {
        if positions.peek() == Some(&byte) {
            offsets.insert(byte, index);
            positions.next();
        }
        total = index + 1;
    }
    offsets.insert(content.len(), total);
    let char_offset = |byte| offsets[&byte];
    let mut rows = Vec::new();
    if headings.is_empty() || headings[0].0 > 0 {
        rows.push(Section {
            id: "s1".into(),
            title: title.into(),
            level: 0,
            path: vec![],
            body_start: 0,
            byte_start: 0,
            byte_end: headings.first().map(|h| h.0).unwrap_or(content.len()),
            body_end: headings
                .first()
                .map(|h| char_offset(h.0))
                .unwrap_or_else(|| content.chars().count()),
        });
    }
    let mut parents: Vec<(u8, String)> = Vec::new();
    for (index, (_, end, level, heading)) in headings.iter().enumerate() {
        while parents.last().is_some_and(|(parent, _)| parent >= level) {
            parents.pop();
        }
        parents.push((*level, heading.clone()));
        rows.push(Section {
            id: format!("s{}", rows.len() + 1),
            title: heading.clone(),
            level: *level,
            path: parents.iter().map(|(_, name)| name.clone()).collect(),
            body_start: char_offset(*end),
            byte_start: *end,
            byte_end: headings
                .get(index + 1)
                .map(|h| h.0)
                .unwrap_or(content.len()),
            body_end: headings
                .get(index + 1)
                .map(|h| char_offset(h.0))
                .unwrap_or_else(|| content.chars().count()),
        });
    }
    rows
}

fn normalized(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn select(rows: &[Section], wanted: &str) -> Option<usize> {
    let wanted = normalized(wanted);
    let numbered = wanted.chars().all(|c| c.is_ascii_digit() || c == '.');
    let groups = [
        rows.iter()
            .enumerate()
            .filter(|(_, row)| row.id == wanted)
            .map(|(i, _)| i)
            .collect(),
        rows.iter()
            .enumerate()
            .filter(|(_, row)| normalized(&row.title) == wanted)
            .map(|(i, _)| i)
            .collect(),
        rows.iter()
            .enumerate()
            .filter(|(_, row)| {
                numbered
                    && row
                        .title
                        .chars()
                        .take_while(|c| c.is_ascii_digit() || *c == '.')
                        .collect::<String>()
                        .trim_end_matches('.')
                        == wanted.trim_end_matches('.')
            })
            .map(|(i, _)| i)
            .collect(),
        rows.iter()
            .enumerate()
            .filter(|(_, row)| normalized(&row.title).contains(&wanted))
            .map(|(i, _)| i)
            .collect(),
    ];
    for group in groups {
        let matches: Vec<usize> = group;
        if !matches.is_empty() {
            return (matches.len() == 1).then_some(matches[0]);
        }
    }
    None
}

pub fn scope_end(rows: &[Section], index: usize) -> usize {
    let mut end = index;
    while end + 1 < rows.len() && rows[end + 1].level > rows[index].level {
        end += 1;
    }
    end
}
