#!/usr/bin/env python3
"""Print ordered CI schema migrations; self-test checks every migration is classified."""
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent

# Ordered schema migrations matching the deployed database contract.
LOAD = [
    "0000_schema.sql",
    "0003_chat_image.sql",
    "0004_note_visibility.sql",
    "0005_orphan_cleanup.sql",
    "0006_note_tag.sql",
    "0008_drop_stray_checkpoint_tables.sql",
    "0009_widen_password_reset_token_hash.sql",
    "0010_chat_latest_index.sql",
    "0011_chat_summary_watermark.sql",
    "0012_agent_checkpoint_cleanup.sql",
    "0013_conversation_foreign_keys.sql",
    "0014_category_identity.sql",
    "0015_announcement_notifications.sql",
    "0016_confirmation_question.sql",
    "0017_account_action_version.sql",
    "0018_chat_memory_source_role.sql",
    "0019_chat_task_input.sql",
    "0020_personal_message_deletion.sql",
    "0021_automation_results.sql",
    "0022_note_cover_fit.sql",
    "0023_gallery_library.sql",
    "0024_image_generation.sql",
    "0025_automation_announcements.sql",
    "0026_automation_changes.sql",
    "0027_article_reference_integrity.sql",
    "0028_turn_cleanup.sql",
    "0029_image_job_lifecycle.sql",
    "0030_gallery_image_deletion.sql",
    "0031_gallery_storage.sql",
    "0032_gallery_public_ids.sql",
    "0033_deletion_reference_indexes.sql",
    "0034_chat_run_claim.sql",
]

EXCLUDED = {
    "0001_rag_vectors.sql",  # Optional vector extension, tested separately.
    "0002_owner_to_app.sql",  # Production role ownership, not the CI role.
    "0007_drop_note_tags_column.sql",  # Destructive cutover; deployed compatibility column remains.
}


def classified() -> dict[str, str]:
    """Map numbered migrations to their CI schema classification."""
    out: dict[str, str] = {}
    for f in sorted(HERE.glob("0[0-9][0-9][0-9]_*.sql")):
        name = f.name
        if name in LOAD:
            out[name] = "load"
        elif name in EXCLUDED:
            out[name] = "excluded"
    return out


def self_test() -> int:
    """Require complete classification, existing files, and ordered schema loading."""
    bad: list[str] = []
    on_disk = sorted(f.name for f in HERE.glob("0[0-9][0-9][0-9]_*.sql"))
    known = classified()

    versions: dict[str, str] = {}
    for name in on_disk:
        version = name[:4]
        if version in versions:
            bad.append(f"迁移编号 {version} 重复：{versions[version]}、{name}")
        versions[version] = name
        if name not in known:
            bad.append(f"{name} 未归类；加入 LOAD，或在 EXCLUDED 中说明排除原因")

    for name in LOAD:
        if not (HERE / name).exists():
            bad.append(f"LOAD 里的 {name} 在磁盘上不存在")
    for name in EXCLUDED:
        if not (HERE / name).exists():
            bad.append(f"EXCLUDED 里的 {name} 在磁盘上不存在（改了名就把它一起改掉）")

    if LOAD != sorted(LOAD):
        bad.append(f"LOAD 必须按文件名升序（语义序），现在是 {LOAD}")

    print(f"编号迁移 {len(on_disk)} 份：CI 加载 {len(LOAD)}、排除 {len(EXCLUDED)}")
    if bad:
        print(f"\n✗ {len(bad)} 处不对：")
        for b in bad:
            print("  - " + b)
        return 1
    print("✅ 每一个编号迁移都归过类")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if any(a.startswith("-") for a in argv):
        print(__doc__.strip())
        return 2
    for name in LOAD:
        print(HERE / name)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
