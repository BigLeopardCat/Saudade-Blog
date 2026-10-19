#!/usr/bin/env python3
"""CI 建库要按序加载哪几个编号迁移 —— **这份清单是唯一事实源**（20261018）。

## 为什么要有这么一份

`.github/workflows/deploy.yml` 的「Bootstrap PostgreSQL schema」此前**只加载
`0000_schema.sql`**，而 `tests/pg_integration.rs` 带着 `TEST_PG_URL` 会真跑
（CI 有服务容器）。于是任何"依赖某个编号迁移建出来的表"的判据，在 CI 上都会红在
**库结构不全** —— 红得与本刀代码无关，而**本机全绿**（本机的库是完整的）。
这是最难自己发现的一类：本机怎么跑都是绿的。

这个洞**在 20261018 之前就有**（`rag_vector` 也没进 CI），只是那时没有任何 CI 判据
碰过那些表，所以没人看见。加了 `chat_image` 之后它第一次会咬人。

## 为什么不是"在 CI 里再抄一份文件清单"

那就又是"同一件事写两处"。CI 那一步改成**遍历本脚本打印出来的清单**，
清单与排除集都只住在这里；`--self-test` 断言**磁盘上每一个 `00*.sql` 都被归过类**
—— 下次有人加 `0004` 却忘了说它进不进 CI，红的是这条自检，而不是三个月后
某个集成测的假红。

## 排除集里那两份为什么排除

- `0001_rag_vectors.sql`：要 `vector` 类型，而 CI 的服务容器是**纯 `postgres:16`**
  （`deploy.yml` 的 `services.postgres`，没有 pgvector）⇒ 加进去 CI 直接红在建库那一步。
  向量那半边本来就有自己的判据（`verify_vectors.py`，逐位对账）。
- `0002_owner_to_app.sql`：把 owner 改成 `saudade_app`，而 CI 那个**一次性容器里
  没有这个角色**（角色是生产上手工建的，见 `CONTRIBUTING.md` §2.1）。

⚠️ 因为 `0002` 不在 CI 里，**CI 的 owner 语义与生产不同**（CI 是 `postgres`）：
CI 绿**不代表** owner 对。生产上以应用角色跑那一份，见 `0003_chat_image.sql` 头注。

## 跑法

    python3 scripts/migration/pg/ci_schema_files.py             # 按序打印要加载的文件
    python3 scripts/migration/pg/ci_schema_files.py --self-test # 自检（判据自己）
"""
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent

# 按序加载（文件名升序就是语义序：先建库结构，再往上加东西）。
LOAD = [
    "0000_schema.sql",
    "0003_chat_image.sql",
    # 0004 只加一条 CHECK（约束），0005 只动数据 —— 两者都不建表，但**必须**在 CI 里跑：
    # `tests/pg_integration.rs` 有判据要真去撞那条约束（种一行 `('private', true)` 看它
    # 是不是真被拒）。不加载的话那条判据在 CI 上必红，且红在"库结构不全"这种与代码无关的
    # 原因上（本机永远绿 —— 本机的库是完整的）。
    "0004_note_visibility.sql",
    "0005_orphan_cleanup.sql",
    # 0006 建 `note_tag` 关联表（+ 回填）。**必须**在 CI 里：`tests/pg_integration.rs`
    # 有一族判据要真去读那张表（往返、级联、撞号、移动）。回填在 CI 是 0 行（库是现建的、
    # 没有带标签的文章），但**建表那一半是承重的** —— 不加载的话那一族判据会红在
    # "库结构不全"上，与本刀代码无关，而本机永远绿。
    "0006_note_tag.sql",
    # 0008 删那四张 langgraph checkpoint 残留表（见那份文件头注）。进 CI 的理由是
    # **让这段 SQL 真被执行一次**：它是四条 `DROP TABLE IF EXISTS` + 两个 DO 块，
    # 在现建的 CI 库上全是 no-op（那四张表本来就不在），而"SQL 有语法错/DO 块里的
    # `to_regclass` 写错"这类坏法只有真跑一遍才看得见。**别读成"残留被清这件事被测过了"**
    # —— 真判据是产线预检（有数据就拒跑）+ 跑完 `verify_parity.py` 回绿。
    "0008_drop_stray_checkpoint_tables.sql",
    # 0009 把 `password_reset_token.token_hash` 从 `char(64)` 加宽到 `varchar(255)`
    # （恢复码哈希改 Argon2id，PHC 串约 97 字符，见那份文件头注）。**必须进 CI**：
    # `0000` 建出来的那一列永远是 `char(64)`，而代码 20261020 起写的是 PHC 串 ⇒
    # 不加载它，CI 的库结构就比生产**窄**，日后任何一条碰"签发恢复码"的判据都会红在
    # `value too long` 上——红得与本刀代码无关，而本机永远绿（本机的库是宽的）。
    # 与 0007 的区别：0007 是**删列**（contract 那一半，CI 跑它就等于比生产靠前），
    # 而这一份是**加宽**、跑在旧代码前面也完全无害（见文件头注）。
    "0009_widen_password_reset_token_hash.sql",
]

# 不进 CI 的（理由见模块头注，改这个集合要把理由一起写进去）。
EXCLUDED = {
    "0001_rag_vectors.sql",
    "0002_owner_to_app.sql",
    # 0007 删 `note.tags` 那一列。**不能进 CI**：它是 contract 那一半，只该在 soak 之后
    # 由人手在生产上跑一次。CI 的库每次都是现建的（`0000` 里那列还在），
    # 把 0007 塞进 LOAD 等于让 CI 库比生产**更靠前**，而"列已经不在了"这件事
    # 恰恰是 soak 期还没到的事。
    "0007_drop_note_tags_column.sql",
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
