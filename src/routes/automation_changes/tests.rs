use super::*;

#[test]
fn only_explicit_domain_changes_are_accepted() {
    for write in [
        json!({"kind":"sql","change":{"query":"DELETE FROM note"}}),
        json!({"kind":"categories","change":{"version":"a".repeat(64),"intent":{"action":"create","fields":{"name":"x"}},"ownerId":8}}),
        json!({"kind":"categories","change":{"version":"a".repeat(64),"intent":{"action":"create","fields":{"name":"x"}}},"extra":true}),
    ] {
        assert!(serde_json::from_value::<Change>(write).is_err());
    }
    assert!(
        serde_json::from_value::<Request>(json!({"runId":"run","write":{},"ownerId":8})).is_err()
    );
}
