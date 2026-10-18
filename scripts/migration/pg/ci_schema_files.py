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
]

# 不进 CI 的（理由见模块头注，改这个集合要把理由一起写进去）。
EXCLUDED = {
    "0001_rag_vectors.sql",
    "0002_owner_to_app.sql",
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
