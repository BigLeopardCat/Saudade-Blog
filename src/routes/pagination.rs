//! Optional bounded page windows for administrator lists.

pub fn window(page: Option<u64>, size: Option<u64>) -> Result<Option<(u64, u64)>, &'static str> {
    match (page, size) {
        (None, None) => Ok(None),
        (page, Some(size)) if (1..=50).contains(&size) => {
            let page = page.unwrap_or(1);
            if !(1..=10000).contains(&page) {
                return Err("页码应为1至10000");
            }
            Ok(Some((size, (page - 1) * size)))
        }
        _ => Err("分页必须提供page_size，范围为1至50"),
    }
}

#[cfg(test)]
mod tests;
