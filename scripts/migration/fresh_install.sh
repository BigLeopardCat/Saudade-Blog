#!/usr/bin/env bash
# =============================================================================
# 从零建库（20261003）：基架快照 + **快照之后**的增量迁移
#
#   bash scripts/migration/fresh_install.sh <库名> [mysql 的位置参数…]
#   bash scripts/migration/fresh_install.sh saudade_dev -uroot -p
#
# CI 里 `mysql` 不在 runner 上，走服务容器（`$MYSQL_BIN` 允许带前缀、按空格拆词）：
#   MYSQL_BIN="docker exec -i $CID mysql" bash scripts/migration/fresh_install.sh \
#       saudade_blog_it -h127.0.0.1 -P3306 -uroot -proot
# ⚠️ `docker exec` 那个 **`-i` 不能少**：SQL 是从 stdin 喂进去的，而 docker exec 默认不接
# stdin —— 少了它 mysql 收到空输入、**每一步都"成功"**，最后建出一个空库。
#
# ── 为什么不能"按文件名顺序把 *.sql 全跑一遍" ────────────────────────────────
# CONTRIBUTING §2.1 在 20261003 之前教的正是那一版，**它跑不通**：
# `0000_base_schema.sql` 是 **20261001 的生产库快照**，里面已经含有那天之前所有增量
# 迁移的效果；而 20261001 之前的迁移大多是无保护的 `ALTER TABLE … ADD COLUMN`
# （没有 `IF NOT EXISTS` 守卫）。照单全跑必然在半路撞上
# `ERROR 1060 Duplicate column name` —— 20261003 在空库上实测，40 个文件里 **17 个**
# 会红（`note_cover_crop_20260912` / `note_author_20261001` / `user_chat_quota_20260929`…），
# `chat_conversation_20260903.sql` 还会撞 `ERROR 1050 Table 'conversation' already exists`。
# （撞错的那 17 个不是"坏迁移"：它们在快照之前、本来就该在快照之前跑完。）
#
# 正确规则：**基架即快照，之后只补快照日期之后的迁移**。日期就是文件名里的
# `_YYYYMMDD.sql` 后缀，本脚本按它筛。加了新迁移**不需要**动本脚本；将来重新导出基架时，
# 只需把下面的 `SNAPSHOT` 改成新的导出日。
#
# ── ⚠️ 关于 `USE saudade_blog;`（本目录最危险的一条约定）────────────────────
# 每个迁移文件开头都写死 `USE saudade_blog;`。本脚本把它**一律剥掉**，并且库名永远用
# 位置参数显式传给 `mysql`。不剥的话，`mysql <你的库> < 某个迁移.sql` 会在读到那一行的
# 瞬间切到**生产库**——那不是"跑错库"，那是把生产库改了，而且 mysql 不会报错。
# 剥完还有一道 grep 复查：残留 `USE` 行直接中止，不让它有机会执行。
#
# 另：本脚本**拒绝**把 `saudade_blog` 当目标库（下面第 ① 步）。理由是同一件事的兜底：
# 万一上面的剥离哪天失效，最坏也只是打在一个凭空建不出来的名字上，而不是生产库。
# =============================================================================
set -euo pipefail

# 基架快照日：`0000_base_schema.sql` 中已包含**这一天（含）之前**所有迁移的效果。
# 重新导出基架时改这里，并把 0000 那份文件整体替换（它自己的头注写着这条纪律）。
SNAPSHOT=20261001

# 夹具与作者的一次性脚本：不是站点运行所需的结构（清单与 CONTRIBUTING §2.1 的表同源）。
# ⚠️ 这张表**只能写成字面 pattern**，不许改成 `case "$name" in $FIXTURES)` ——case 的 `|`
# 是语法、不是被展开出来的分隔符：变量展开后整串只是一个 pattern（`a|b` 当成字面
# `a|b` 去匹配），于是**一个都跳不过去**，而且不报错。20261003 就是这么把
# `zako_role_20261002.sql` 放进空库跑了一遍（它是空转脚本，没造成后果）。
skip_fixture() {
    case "$1" in
        golden_*.sql|test_accounts_*.sql|user_rename_sora_*.sql) return 0 ;;
        user_remove_legacy_hash_account_*.sql) return 0 ;;
        superadmin_role_*.sql|secretary_role_*.sql|zako_role_*.sql) return 0 ;;
    esac
    return 1
}

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# 连库命令。默认本机 mysql 客户端；CI 里是 `docker exec <容器> mysql`。
# **故意不加引号**：${MYSQL_BIN} 按空格拆词，这样多词的命令前缀才成立（见头注的用法）。
MYSQL_BIN=${MYSQL_BIN:-mysql}

# ── ① 参数 ──────────────────────────────────────────────────────────────────
if [ $# -lt 1 ]; then
    echo "用法：bash scripts/migration/fresh_install.sh <库名> [mysql 的位置参数…]" >&2
    echo "例：  bash scripts/migration/fresh_install.sh saudade_dev -uroot -p" >&2
    exit 2
fi
DB=$1
shift
# 连库命令组装成**数组**：`${MYSQL_BIN}` 故意不加引号（按空格拆词，多词前缀才成立），
# 而 mysql 自己的位置参数原样跟在后面。⚠️ 必须**在 `shift` 之后**组装（`$@` 此时才是
# mysql 的参数），否则库名会被重复塞进数组；也别在 `apply` 里用 `"$@"` 取它们——函数内的
# `$@` 是该函数自己的位置参数（=那个 SQL 文件名），拿它当 mysql 的参数会把文件名当库名。
#
# 客户端字符集**由脚本自己钉死**（20261003 CI 首跑抓出来的）：迁移文件是 UTF-8，里面大量
# 出现中文标识符（列别名 `AS 行数`）、`GROUP BY 昵称组`、中文字面量与列注释，而 mysql 客户端的
# 默认字符集取自**运行环境的 locale**——本机是 UTF-8，CI 的 `docker exec` 进容器时 LANG 为空、
# 回落成 latin1，同一份文件在那边被按 latin1 解释 ⇒ 多字节标识符被拆出"看着像空白"的字节
# ⇒ `ERROR 1064 … near '一组, COUNT(*) AS 行数'`（本机用 `--default-character-set=latin1`
# 复现过）。跟 SQL 写得好不好无关，只跟谁在读它有关；钉死 utf8mb4 后两边一致。
# 放在 `"$@"` 之前 ⇒ 调用方仍可自己传一个来覆盖。
MYSQL=( ${MYSQL_BIN} --default-character-set=utf8mb4 "$@" )
if [ -z "$DB" ]; then
    echo "库名不能为空" >&2
    exit 2
fi
# `saudade_blog` 是**本机产线**用的库名（本仓的迁移文件里带 `USE` 的那些也写死它）。
# 脚本自己是从零建库、不该碰运行中的库，所以默认拒收这个名字；下面第 ② 步那道"库必须为空"
# 才是真正的保险（产线库里 27 张表，一定会被拦下）——这道名字闸只是让**打错字的后果**
# 更清楚一点。你自己机器上库确实该叫这个名的话，下面这句里明确声明一次即可。
if [ "$DB" = "saudade_blog" ] && [ "${ALLOW_PRODUCTION_NAME:-}" != "1" ]; then
    echo "拒绝：saudade_blog 是**产线**用的库名。本脚本是从零建库，请给它另一个名字" >&2
    echo "（例如 saudade_dev / saudade_blog_it）。" >&2
    echo "如果你是在自己的机器上、库确实就叫这个名，明确声明一次再跑：" >&2
    echo "  ALLOW_PRODUCTION_NAME=1 bash scripts/migration/fresh_install.sh saudade_blog -uroot -p" >&2
    exit 2
fi
case "$DB" in
    *[!A-Za-z0-9_]*)
        echo "库名只允许字母/数字/下划线（收到：$DB）——它要被拼进命令行，不放行别的字符" >&2
        exit 2 ;;
esac

# ── ② 目标库必须还不存在或为空 ──────────────────────────────────────────────
# 非空的话说明这个库已经有结构了：基架是 `IF NOT EXISTS`（静默 no-op），而快照后的迁移
# 会在已有的列上撞重复 —— 报错信息会指向迁移文件，读起来像是迁移坏了。提前拦住更省事。
EXISTING=$("${MYSQL[@]}" -N -B -e \
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB';" 2>/dev/null || echo 0)
if [ "${EXISTING:-0}" != "0" ]; then
    echo "拒绝：库里已经有 $EXISTING 张表了。本脚本是**从零建库**。" >&2
    echo "想补跑某一份迁移就单独跑那一份（记得剥掉它开头的 USE 行）。" >&2
    exit 2
fi

echo "== 目标库：$DB（快照日 $SNAPSHOT，只跑快照之后的迁移）"
"${MYSQL[@]}" -e \
    "CREATE DATABASE IF NOT EXISTS \`$DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# ── ③ 应用一个 SQL 文件（剥 USE + 显式点名库名）──────────────────────────────
apply() {
    local f=$1
    # 剥掉 `USE xxx;` 整行（允许前后空白、行尾注释）。剩下的 `-- USE xx` 之类是注释，不动。
    local sql
    sql=$(sed -E 's/^[[:space:]]*USE[[:space:]]+[^;]*;[[:space:]]*(--.*)?$//' "$f")
    if printf '%s\n' "$sql" | grep -qiE '^[[:space:]]*USE[[:space:]]'; then
        echo "✗ $f 里仍有剥不掉的 USE 行，中止（它会把语句打到那个库上）" >&2
        printf '%s\n' "$sql" | grep -inE '^[[:space:]]*USE[[:space:]]' >&2
        exit 1
    fi
    printf '%s\n' "$sql" | "${MYSQL[@]}" "$DB" >/dev/null
}

echo "== ① 基架（0000_base_schema.sql，26 张表）"
apply "$HERE/0000_base_schema.sql"

echo "== ② 快照之后的增量迁移"
n=0
while IFS= read -r f; do
    name=$(basename "$f")
    if skip_fixture "$name"; then
        echo "   ⇢ 跳过夹具 $name"
        continue
    fi
    # 文件名里的日期后缀：`_YYYYMMDD.sql`。基架自己那份没有日期（也不该跑到这里）。
    date=$(printf '%s' "$name" | grep -oE '_[0-9]{8}\.sql$' | grep -oE '[0-9]{8}' || true)
    if [ -z "$date" ]; then
        echo "   ↷ $name（文件名里没有 YYYYMMDD，跳过）"
        continue
    fi
    if [ "$date" -le "$SNAPSHOT" ]; then
        continue   # 快照那天及更早的，效果已经在基架里
    fi
    echo "   → $name"
    if ! apply "$f"; then
        echo "✗ $name 失败。上面的 SQL 报错就是原因；库停在这一步，没有半途而废的假成功。" >&2
        echo "  修好它再重跑（本脚本不幂等：先 DROP DATABASE \`$DB\`; 再来一遍更省事）。" >&2
        exit 1
    fi
    n=$((n + 1))
done < <(ls "$HERE"/*.sql | sort)

# ── ④ 收尾核对 ─────────────────────────────────────────────────────────────
TABLES=$("${MYSQL[@]}" -N -B -e \
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB';")
echo "== 完成：基架 26 张 + $n 份迁移 ⇒ 库里共 $TABLES 张表"
echo "   连库串形如：mysql://用户:密码@127.0.0.1:3306/$DB"
