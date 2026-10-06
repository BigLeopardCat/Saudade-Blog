#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  一次性容器：建库 → 应用账号 → 第一个管理员（**幂等，每次 up -d 都会重跑一遍**）
#
#  它跑在 mysql:8.0 那个镜像里（自带 mysql 客户端），宿主只挂两处只读进来
#  （compose 里是 `../../scripts:/repo/scripts:ro` + 本文件挂到 /repo/deploy/docker/），
#  所以这里**不需要**为它单独建镜像，也不需要 `docker exec mysql …` 那种手搓。
#  ⚠️ 挂载面别再放宽：bind mount 不吃 .dockerignore，挂仓库根会把根目录那份 `.env` 一起
#     暴露给这个容器（容器里跑的就是挂进来的代码，没必要多看别的）。
#
#  ── 为什么不用 `docker-entrypoint-initdb.d` ──────────────────────────────────
#  那是 MySQL 官方镜像的"第一次初始化"钩子，两处要命的地方：
#   ① 它跑在 `--skip-networking` 的**临时 server** 上（SQL 从 stdin 喂给客户端，客户端走不了），
#      而 `fresh_install.sh` 里写死 `host=127.0.0.1` 的那一连串查询会直接 Connection refused；
#   ② 它**只在空数据目录的首次初始化**执行一次 ⇒ 改了 `ADMIN_PASS` 再 `up -d` 口令不变、
#      而且**不报错**（正是本仓最警惕的那类静默失败）。
#  换成这个一次性服务之后，`up -d` 就是"把配置收敛到目标态"，每次都能重跑。
#
#  ── 幂等规则（三条，各自独立）────────────────────────────────────────────────
#   ① 库里已有表 ⇒ 整段跳过建库（**脚本绝不 DROP**）。判据是 information_schema 的表数，
#      不是"建库语句有没有报错"——基架是 `IF NOT EXISTS`，报错那条路根本不会响。
#   ② 应用账号 = `CREATE USER IF NOT EXISTS` + **无条件 `ALTER USER`**：所以改了
#      `generated/.credentials` 里的 DB_PASS 再 `up -d`，库里那份口令就会跟着对齐
#      （后台的 DATABASE_URL 由 prepare.sh 从同一个文件生成，两边同源）。
#   ③ 管理员只在**一个都没有**时才 INSERT。所以改 ADMIN_PASS 重跑**不会**改已存在账号的
#      口令 —— 那是故意的（否则等于给"随手改个文件"发了一把重置站长密码的钥匙）。
#      改已有口令的那句 SQL 写在 README 的《改口令》一节。
#
#  ── 应用账号的 host 是 `'%'`，与裸机那套（`@'localhost'`）**必须不同**────────────
#  这一套里 Rust 后端走 host 网络、从宿主回环连过来，在 MySQL 眼里那个来源地址是
#  **docker 网桥的网关地址**（172.x.0.1），不是 127.0.0.1 ⇒ `@'localhost'` 一条都匹配不上，
#  症状是后端一直 `Access denied for user 'saudade_blog'@'172.18.0.1'`。
#  与之配套的还有 mysql 服务的 `MYSQL_ROOT_HOST: '%'`（官方镜像默认只建 root@localhost，
#  而本脚本这个容器连过来的地址同样不是 localhost）。
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# 这些键由 compose 的 `env_file: generated/.credentials` 注入 —— **缺席就炸，不许给默认值**：
# 默认值在这里的含义是"悄悄用一个跟实际不同的口令建库"，那比直接失败难查得多。
DB="${DB_NAME:?缺少 DB_NAME（generated/.credentials 没挂进来？）}"
DB_USER="${DB_USER:?缺少 DB_USER}"
DB_PASS="${DB_PASS:?缺少 DB_PASS}"
ROOT_PASS="${MYSQL_ROOT_PASSWORD:?缺少 MYSQL_ROOT_PASSWORD}"
ADMIN_USER="${ADMIN_USER:?缺少 ADMIN_USER}"
ADMIN_NICK="${ADMIN_NICK:-站长}"
ADMIN_PASS="${ADMIN_PASS:?缺少 ADMIN_PASS}"
MYSQL_HOST="${MYSQL_HOST:-mysql}"
MIG_DIR="${MIG_DIR:-/repo/scripts/migration}"

log()  { printf '[db-init] %s\n' "$*"; }
die()  { printf '[db-init] ✗ %s\n' "$*" >&2; exit 1; }
warn() { printf '[db-init] ⚠️  %s\n' "$*" >&2; }

# 口令走 `--defaults-extra-file`（600 的临时文件）而**不是 `-p****`**：命令行参数对整个
# 宿主机的 `ps` 可见，容器里也一样。字符集在这里一并钉死（迁移文件里大量中文标识符，
# 客户端字符集跟着 locale 走会静默降级 —— 那件事在 CI 的 docker exec 上真发生过）。
CNF="$(mktemp)"; chmod 600 "$CNF"
trap 'rm -f "$CNF"' EXIT
{
    printf '[client]\nuser=root\npassword=%s\nhost=%s\nport=3306\ndefault-character-set=utf8mb4\n' \
        "$ROOT_PASS" "$MYSQL_HOST"
} >"$CNF"

mysql_root() { mysql --defaults-extra-file="$CNF" "$@"; }
sql_quote()  { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/''/g"; }

case "$DB" in
    *[!A-Za-z0-9_]*) die "库名只允许字母/数字/下划线（收到：$DB）" ;;
esac

# ── 0. 等 MySQL 真的能连 ──────────────────────────────────────────────────────
# compose 的 `service_healthy` 已经等过一轮，这里再兜一层**不是重复**：首次初始化时官方
# 镜像会先起一个临时 server 建库、再关掉、再起正式的（healthcheck 打在临时那个上也可能绿）。
# 60 秒还连不上就出去 —— 失败要响亮，而不是让后面的 SQL 各自报一堆莫名其妙的错。
log "等待 $MYSQL_HOST:3306 就绪…"
ready=0
for _ in $(seq 1 30); do
    if mysql_root -N -B -e 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
done
[ "$ready" = 1 ] || die "连不上 MySQL（root@$MYSQL_HOST）。看 mysql 容器在不在、generated/.credentials 里的 MYSQL_ROOT_PASSWORD 与它实际的口令是否一致。"

# ── 1. 建库（已有表就跳过）───────────────────────────────────────────────────
n="$(mysql_root -N -B -e \
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$(sql_quote "$DB")';")"
if [ "$n" != "0" ]; then
    log "库里已有 $n 张表 ⇒ 跳过建库（脚本绝不 DROP 已有数据）"
    # "有表"不等于"建全了"。这里只把**看得见的**摆出来（20261007），**不下结论**：
    # 判"该跑的迁移跑全了没有"需要知道完整的筛选规则（快照日 + 夹具名单 + 强制补跑名单），
    # 那套规则住在 scripts/migration/fresh_install.sh 里；在这里抄一份就会各漂各的，而抄不准
    # 的版本会把快照日之前的几十份迁移全判成缺失（它们的标记本来就不在库里）—— 那是假红。
    flags="$(mysql_root -N -B "$DB" -e 'SELECT flag_name FROM migration_flags ORDER BY applied_at;' 2>/dev/null || true)"
    if [ -n "$flags" ]; then
        log "迁移标记 $(printf '%s\n' "$flags" | wc -l | tr -d ' ') 个，最近一条：$(printf '%s\n' "$flags" | tail -1)"
        log "  （要核完整性：拿 scripts/migration/ 里那些带 _YYYYMMDD 且日期晚于 fresh_install.sh 快照日的文件名对一遍）"
    else
        warn "库里没有 migration_flags 表或一行标记都没有 —— 这个库不是这几份迁移建出来的"
        warn "  把它当「新库的基线」之前，先确认它到底是谁建的。"
    fi
else
    [ -d "$MIG_DIR" ] || die "找不到迁移目录 $MIG_DIR —— 宿主仓库根没挂进来？"
    log "从零建库（基架快照 + 快照之后的增量迁移），这会跑一会儿…"
    # 建库只有这一个入口（= 裸机 install.sh 用的同一个脚本），免得两份"从零建库"哪天各漂各的。
    #   ALLOW_PRODUCTION_NAME=1：脚本默认拒收 `saudade_blog` 这个名字（防在生产机上打错字）。
    #     而迁移文件里绝大多数写死了 `USE saudade_blog;` ⇒ 自建部署的库名**必须**是它。
    #   MYSQL_BIN 多词前缀把 --defaults-extra-file 顶到第一个位置参数 ⇒ root 口令不进 argv。
    #   `-i` 的教训写在 fresh_install.sh 头注里：SQL 是从 stdin 喂进去的，少了它 mysql
    #     收到空输入、**每一步都"成功"**，最后建出一个空库。这里没有 docker exec，不涉及；
    #     但管道那头的 exit code 必须真的传回来（下面用 if ! 捕，不用 $?）。
    if ! MYSQL_BIN="mysql --defaults-extra-file=$CNF" ALLOW_PRODUCTION_NAME=1 \
         bash "$MIG_DIR/fresh_install.sh" "$DB" 2>&1 | sed 's/^/          /'; then
        die "建库失败（上面那些 SQL 报错就是原因；库停在这一步，没有半途而废的假成功）。
     修法：`docker compose exec mysql mysql -uroot -p… -e 'DROP DATABASE \`$DB\`;'` 之后重跑 up -d。"
    fi
    n="$(mysql_root -N -B -e \
        "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$(sql_quote "$DB")';")"
    [ "$n" != "0" ] || die "建库报告成功，但库里一张表都没有 —— 迁移一份都没跑进去，别继续"
    log "建库完成：$n 张表"
fi

# ── 2. 应用账号 ──────────────────────────────────────────────────────────────
# 每一次都 ALTER（不只是 CREATE）：这样"改了 .credentials 里的 DB_PASS 再 up -d"是一条
# 真的能收敛的路径，而不是留一个"文件改了、库里没改"的错位。
printf "CREATE USER IF NOT EXISTS '%s'@'%%' IDENTIFIED BY '%s';\n\
ALTER USER '%s'@'%%' IDENTIFIED BY '%s';\n\
GRANT ALL PRIVILEGES ON \`%s\`.* TO '%s'@'%%';\nFLUSH PRIVILEGES;\n" \
    "$(sql_quote "$DB_USER")" "$(sql_quote "$DB_PASS")" \
    "$(sql_quote "$DB_USER")" "$(sql_quote "$DB_PASS")" \
    "$(sql_quote "$DB")" "$(sql_quote "$DB_USER")" | mysql_root
log "应用账号 $DB_USER@'%' 就绪（口令与 generated/backend.env 里的 DATABASE_URL 同源）"

# ── 3. 第一个管理员 ──────────────────────────────────────────────────────────
cnt="$(mysql_root -N -B "$DB" -e "SELECT COUNT(*) FROM \`user\` WHERE role='admin';")"
if [ "$cnt" != "0" ]; then
    log "库里已有 $cnt 个管理员 ⇒ 不再建（本项目没有注册入口，加人只能 INSERT）"
    if [ "$cnt" = 1 ]; then
        log "  管理员用户名：$(mysql_root -N -B "$DB" -e "SELECT username FROM \`user\` WHERE role='admin' LIMIT 1;")"
    fi
else
    # 先看一眼**同名账号**（20261007 加）：`user.username` 上有唯一键，撞上去的话 MySQL 甩一句
    # `Duplicate entry` 然后脚本带着一个指向 SQL 的报错退出 —— 读起来像是脚本坏了，实际是
    # "你换了个管理员用户名，而库里早就有一个同名（非 admin）账号"。说清楚，并给出两条出路。
    dupe="$(mysql_root -N -B "$DB" -e \
        "SELECT id, username, role FROM \`user\` WHERE username='$(sql_quote "$ADMIN_USER")' LIMIT 1;" 2>/dev/null || true)"
    [ -z "$dupe" ] || die "库里已经有同名账号（id 账号 角色 = $dupe），而它不是 role=admin。
     本项目没有注册入口，加人只能 INSERT ⇒ 这里先拦住，不让你看到一句 Duplicate entry。两条出路：
       ① 换个用户名：改 generated/.credentials 里的 ADMIN_USER 再 up -d 重跑；
       ② 就是它的话，把角色改过来：
          docker compose exec mysql mysql -uroot -p<root口令> $DB -e \"UPDATE \\\`user\\\` SET role='admin' WHERE username='$ADMIN_USER';\""
    # 无盐单轮 SHA-256 是**旧格式**：`verify_password` 认它，并在首次登录成功后把那
    # 一行就地升级成 Argon2id（用户无感）。这也是"手上只有 mysql 客户端"时最省事的写法。
    printf "INSERT INTO \`user\` (username, nickname, password, role)\n\
VALUES ('%s', '%s', SHA2('%s', 256), 'admin');\n" \
        "$(sql_quote "$ADMIN_USER")" "$(sql_quote "$ADMIN_NICK")" "$(sql_quote "$ADMIN_PASS")" \
        | mysql_root "$DB"
    log "第一个管理员 $ADMIN_USER 已建（**只有 role=admin 能进 /dashboard**）"
    log "  口令在 generated/.credentials 里；首次登录成功后库里那行会自动升级成 Argon2id"
fi

log "✅ 完成。库 $DB：$n 张表"
