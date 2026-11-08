use super::*;
use crate::routes::gallery::{
    self,
    storage::Kind,
    transfers::{enqueue, prepare_in, Intent},
};
use sea_orm::{Database, TransactionTrait};

#[tokio::test]
async fn postgres_local_copy_move_replay_and_reference_integrity() {
    let Ok(url) = std::env::var("TEST_PG_URL") else {
        assert!(std::env::var_os("CI").is_none(), "CI requires TEST_PG_URL");
        return;
    };
    let db = Database::connect(url).await.unwrap();
    let label = format!("storage_{}", uuid::Uuid::new_v4().simple());
    let uid:i32=db.query_one(sql("INSERT INTO \"user\"(username,nickname,password,role,status) VALUES($1,$1,'fixture','admin',0) RETURNING id",vec![label.clone().into()])).await.unwrap().unwrap().try_get("","id").unwrap();
    let root = crate::utils::upload_dir();
    tokio::fs::create_dir_all(&root).await.unwrap();
    let file = format!("{label}.png");
    let data = b"\x89PNG\r\n\x1a\nfixture";
    tokio::fs::write(root.join(&file), data).await.unwrap();
    let original = format!("/api/protect/download/{file}");
    let id: i32 = db
        .query_one(sql(
            "INSERT INTO images(image_url) VALUES($1) RETURNING image_key",
            vec![original.clone().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "image_key")
        .unwrap();
    db.execute(sql(
        "INSERT INTO image_metadata(image_id,display_name) VALUES($1,'fixture.png')",
        vec![id.into()],
    ))
    .await
    .unwrap();
    assert_eq!(
        gallery::read(&db, uid, id).await.unwrap().image_url,
        original
    );
    let row=db.query_one(sql("INSERT INTO note(title,content,cover,created_at,updated_at,is_public,status) VALUES($1,$2,$3,now(),now(),true,'public') RETURNING id",vec![label.clone().into(),format!("![cover]({original})").into(),original.clone().into()])).await.unwrap().unwrap();
    let article: i32 = row.try_get("", "id").unwrap();
    let mut copies = Vec::new();
    let mut jobs = Vec::new();
    for mode in [Mode::Copy, Mode::Move] {
        let preview = prepare_in(
            &db,
            uid,
            Intent {
                mode,
                image_ids: vec![id],
                storage: Some(Kind::Local),
                folder_id: 0,
            },
        )
        .await
        .unwrap();
        let replay = preview.approval.clone();
        let job = enqueue(&db, uid, preview.approval).await.unwrap();
        let jobid = job["id"].as_str().unwrap().to_owned();
        jobs.push(jobid.clone());
        let lease = uuid::Uuid::new_v4().to_string();
        let row=db.query_one(sql("UPDATE image_transfer SET status='copying',lease=$2::uuid WHERE id=$1 RETURNING spec",vec![jobid.clone().into(),lease.clone().into()])).await.unwrap().unwrap();
        let spec: Spec = serde_json::from_value(row.try_get("", "spec").unwrap()).unwrap();
        let worker = Job {
            id: jobid.clone(),
            lease,
            status: "copying".into(),
            spec: spec.clone(),
            attempts: 1,
        };
        work(&db, &worker).await.unwrap();
        // Re-enter the post-publication stage as after a process crash; source cleanup is idempotent.
        db.execute(sql(
            "UPDATE image_transfer SET status='published',finished_at=NULL WHERE id=$1",
            vec![jobid.clone().into()],
        ))
        .await
        .unwrap();
        let resumed = Job {
            status: "published".into(),
            ..worker
        };
        work(&db, &resumed).await.unwrap();
        let result = enqueue(&db, uid, replay).await.unwrap();
        assert_eq!(result["status"], "complete");
        let result_id = result["result"]["imageIds"][0].as_i64().unwrap() as i32;
        if mode == Mode::Copy {
            assert_ne!(result_id, id);
            assert!(root.join(&file).exists());
            copies.push(result_id);
        } else {
            assert_eq!(result_id, id);
            assert!(!root.join(&file).exists());
        }
        assert_eq!(
            &storage::read(&db, &spec.destinations[0]).await.unwrap()[..],
            data
        );
        copies.push(result_id);
    }
    let note = db
        .query_one(sql(
            "SELECT content,cover FROM note WHERE id=$1",
            vec![article.into()],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        note.try_get::<String>("", "cover").unwrap(),
        storage::media_url(id)
    );
    assert!(note
        .try_get::<String>("", "content")
        .unwrap()
        .contains(&storage::media_url(id)));
    let tx = db.begin().await.unwrap();
    assert!(gallery::references::guard_texts(&tx, &[&original])
        .await
        .is_err());
    assert!(
        gallery::references::first_use(&tx, &[gallery::read(&tx, uid, id).await.unwrap()])
            .await
            .unwrap()
            .is_some()
    );
    tx.rollback().await.unwrap();
    db.execute(sql("DELETE FROM note WHERE id=$1", vec![article.into()]))
        .await
        .unwrap();
    copies.sort_unstable();
    copies.dedup();
    for image_id in copies {
        let image = gallery::read(&db, uid, image_id).await.unwrap();
        let loc = storage::resolve(&db, &image).await.unwrap();
        storage::remove(&db, &loc).await.unwrap();
        db.execute(sql(
            "DELETE FROM images WHERE image_key=$1",
            vec![image_id.into()],
        ))
        .await
        .unwrap();
    }
    db.execute(sql("DELETE FROM \"user\" WHERE id=$1", vec![uid.into()]))
        .await
        .unwrap();
    for job in jobs {
        let row = db
            .query_one(sql(
                "SELECT requested_by FROM image_transfer WHERE id=$1",
                vec![job.clone().into()],
            ))
            .await
            .unwrap()
            .unwrap();
        assert!(row
            .try_get::<Option<i32>>("", "requested_by")
            .unwrap()
            .is_none());
        db.execute(sql(
            "DELETE FROM image_transfer WHERE id=$1",
            vec![job.into()],
        ))
        .await
        .unwrap();
    }
}
