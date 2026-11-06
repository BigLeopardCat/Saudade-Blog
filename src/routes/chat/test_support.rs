//! Offline database fixtures for conversation locking and discard fences.

pub(super) fn open_turn(db: sea_orm::MockDatabase) -> sea_orm::MockDatabase {
    use std::collections::BTreeMap;
    let owner: BTreeMap<&str, sea_orm::Value> = BTreeMap::from([("id", 42.into())]);
    db.append_query_results([vec![owner]])
        .append_query_results([Vec::<BTreeMap<&str, sea_orm::Value>>::new()])
}
