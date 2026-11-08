use super::*;
#[test]
fn transfer_scope_is_typed_and_bounded() {
    for ids in [vec![], vec![1, 1], vec![0], (1..=101).collect()] {
        assert!(Intent {
            mode: Mode::Copy,
            image_ids: ids,
            storage: None,
            folder_id: 0
        }
        .normalize()
        .is_err());
    }
    assert!(serde_json::from_value::<Intent>(serde_json::json!({"mode":"copy","imageIds":[1],"storage":"local","folderId":0,"sourcePath":"/etc/passwd"})).is_err());
    assert!(Intent {
        mode: Mode::Copy,
        image_ids: vec![2, 1],
        storage: Some(Kind::Local),
        folder_id: 0
    }
    .normalize()
    .is_ok());
}
#[test]
fn approval_binds_actor_versions_provider_and_destination() {
    let intent = Intent {
        mode: Mode::Move,
        image_ids: vec![1],
        storage: Some(Kind::Local),
        folder_id: 2,
    };
    let loc = Location {
        storage: Kind::Local,
        scope: "/private/uploads".into(),
        bucket: None,
        key: "a.png".into(),
    };
    let mut spec = Spec {
        owner: 1,
        intent,
        images: vec![Image {
            image_key: 1,
            version: "a".repeat(64),
            ..Default::default()
        }],
        sources: vec![loc.clone()],
        destinations: vec![loc],
        folder_name: "covers".into(),
    };
    let baseline = digest(&spec, 100).unwrap();
    spec.destinations[0].key = "new-random-name.png".into();
    assert_eq!(baseline, digest(&spec, 100).unwrap());
    spec.destinations[0].scope = "/changed".into();
    assert_ne!(baseline, digest(&spec, 100).unwrap());
    spec.destinations[0].scope = "/private/uploads".into();
    spec.owner = 2;
    assert_ne!(baseline, digest(&spec, 100).unwrap());
    spec.owner = 1;
    spec.images[0].version = "b".repeat(64);
    assert_ne!(baseline, digest(&spec, 100).unwrap());
    assert_ne!(baseline, digest(&spec, 101).unwrap());
}
