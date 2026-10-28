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
]

EXCLUDED = {
    "0001_rag_vectors.sql",  # Optional vector extension, tested separately.
    "0002_owner_to_app.sql",  # Production role ownership, not the CI role.
    "0007_drop_note_tags_column.sql",  # Destructive cutover; deployed compatibility column remains.
}


def classified() -> dict[str, str]:
    """磁盘上每一个编号迁移 → 它的归属（`load` / `excluded`）。"""
    out: dict[str, str] = {}
    for f in sorted(HERE.glob("0[0-9][0-9][0-9]_*.sql")):
        name = f.name
        if name in LOAD:
            out[name] = "load"
        elif name in EXCLUDED:
            out[name] = "excluded"
    return out


def self_test() -> int:
    """判据自己：**每一个编号迁移都被归过类**，且清单里的文件真的在。"""
    bad: list[str] = []
    on_disk = sorted(f.name for f in HERE.glob("0[0-9][0-9][0-9]_*.sql"))
    known = classified()

    for name in on_disk:
        if name not in known:
            bad.append(
                f"{name} 既不在 LOAD 也不在 EXCLUDED 里 —— 新加的编号迁移必须归类："
                "要么让 CI 加载它（写进 LOAD），要么写进 EXCLUDED 并说明为什么。"
                "不归类的话，CI 里就没有这张表，而依赖它的集成测会红在"
                "「库结构不全」上，与本刀代码无关。")

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
