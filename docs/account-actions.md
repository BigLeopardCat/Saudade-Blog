# 原生账号管理接口

适用于 Agent 的 `freeze_account`、`unfreeze_account`、`set_account_role`、`account_mute`、`account_unmute`。这些工具由模型直接选择，后端只实施确定性的身份、权限、版本和事务检查。

## 接口契约

两条路由都实际注册在 `create_router` 的管理员 `auth_guard` 链内；事务内再次解出身份并以行锁后的数据库账号检查令牌代次、状态和权限，不信任令牌里的角色快照。

`POST /api/protected/account-actions/prepare`：

```json
{"action":"mute","target":{"id":12},"mutedUntil":"2026-11-01T12:00:00"}
```

- action：`freeze | unfreeze | set_role | mute | unmute`。
- target：恰好填写正整数 `id` 或完整 `username`。不接受昵称、前缀、模糊匹配及同给两项；完整账号名未命中唯一账号时要求明确编号。
- `role` 仅 `set_role` 必填；`mutedUntil` 仅 `mute` 必填。未指定字段保留，不接受额外字段。
- `mutedUntil` 是固定 UTC+08 的北京时间钟面，严格 `YYYY-MM-DDTHH:MM:SS`；永久值为 `9999-12-31T23:59:59`。不根据运行机器 TZ 换算，已经到期的截止时间拒绝准备和执行。

准备只读，成功沿用 `{"code":200,"message":"ok","data":Plan}` 响应信封：

```json
{
  "version":"64位十六进制摘要",
  "before":{"id":12,"username":"alice","role":"user","status":0,"mutedUntil":null},
  "after":{"id":12,"username":"alice","role":"user","status":0,"mutedUntil":"2026-11-01T12:00:00"},
  "changed":true,"revokeSessions":false,"notificationCount":1
}
```

快照不含密码、token、token_version、原始用户行或内部业务版本。

`POST /api/protected/account-actions`：

```json
{"version":"准备返回的摘要","intent":{"action":"mute","target":{"id":12},"mutedUntil":"2026-11-01T12:00:00"}}
```

执行必须回送原准备 intent，不将 username 目标隐式替换成 id。返回 `{"changed":true,"beforeVersion":"准备摘要","state":Plan}`，`state` 是原已确认计划；若相关业务、操作者权限或版本改变，拒绝并要求重新确认。HTTP 业务错误仍沿用既有信封 `code != 200`，不是统一的新状态码设计。

## 权限与副作用

所有权限调用现有 `authz::check_freeze` 或 `check_role_change`：禁止自操作与操作超级管理员；普通管理员不能管理同级管理员，角色只能在 user/zako 内调整；超级管理员可调整非超级管理员的身份（沿用旧 check_role_change 对历史未知身份的修复权限），不能通过此入口指派 superadmin。冻结及禁言仍要求目标是已知身份。

| 操作 | 指定字段 | 登录状态 | 必须同步通知 |
| --- | --- | --- | --- |
| freeze | status=1 | token_version +1，即使原本已冻结 | 1 |
| unfreeze | status=0 | 不增加 token_version；冻结前令牌不会恢复 | 变化时 1 |
| set_role | role | 身份变化时 token_version +1 | 变化时 1 |
| mute | muted_until | 保留 status/token_version | 截止时间变化时 1 |
| unmute | muted_until=NULL | 保留 status/token_version | 原列非 NULL 时 1 |

除冻结的安全撤销动作外，完全相同的目标状态不写库、不通知。禁言到期由现有 `authz::is_muted` 判定，自然过期不需要后台任务；对已过期但非 NULL 的列执行 unmute 会清除旧值并通知。通知正文及 created_at 使用固定+08，避免 UTC 开发机的时间偏差。

行锁按操作者/目标编号排序，执行事务采用 SERIALIZABLE；更新结果核验和 `push_notice_checked_at` 均在该事务内，任何写入或通知失败都回滚。不自动重试序列化失败。旧 `/api/temp-users/{id}/status|mute|role` 入口复用同一服务；旧 hours 参数在入口转换一次为绝对北京时间，独立 `send_user_notice` 不受本变更影响。

Agent 继续使用现有签名确认、取消记录及持久执行账。确认重放应从执行账取回原结果；响应丢失或结果未知不得自动再次提交。后端也会以变化后的业务版本拒绝重复使用旧确认；无变化的重放没有写入副作用。该机制不声称跨进程的分布式 exactly-once。

## 迁移与集成

1. 审查并应用 `scripts/migration/pg/0017_account_action_version.sql`。
2. 部署博客后端，再部署支持 `account_actions` 的 Agent；未应用迁移的新后端会失败关闭，不默默忽略版本。
3. 用测试账号检查卡片前后状态、冻结撤销说明、临时/永久禁言、权限变更后的过期确认及回放。

0017 添加 `user.account_action_version bigint NOT NULL DEFAULT 0` 和更新触发器，相关 username/role/status/token_version/muted_until 变动时递增，其他字段不增加。操作者和目标的版本均进入摘要，防止权限撤销后恢复、禁言后解禁等 ABA 情况；不修改 SeaORM Model，也不把内部版本发送给模型。原有 SQL/旧入口同样触发版本更新。不要删除该触发器或手动回拨业务版本。回退应用代码时保留列和触发器，旧后端可以忽略这个附加列。

## 验证

离线运行（不需要生产配置、数据库或模型密钥）：

```bash
cargo test --lib routes::account_actions
python3 scripts/migration/pg/ci_schema_files.py --self-test
```

真实 PostgreSQL 验证仅本领域测试，可使用专属临时数据库：

```bash
TEST_PG_URL=postgres://postgres@127.0.0.1:55437/saudade_blog \
  cargo test --lib routes::account_actions::postgres_tests -- --nocapture
```

测试复用现有 CI 的 `TEST_PG_URL`，在独立 UUID schema 创建最小 user/notification 表并应用真实 0017，结束删除该 schema。PR 的标准 `cargo test` 会运行本测试；无环境变量时打印跳过原因并返回，配置后连接或断言失败均使 CI 失败。该 URL 只能指向一次性测试库；禁止配置成生产连接。本机不运行旧整套 PostgreSQL 集成测试。

2026-10-24 初次交付验证（独立 checkout，基线 `05b8da4`；以下为接入标准 CI 前的历史结果）：

- 原生领域离线套件：4 passed、1 ignored，ignored 明确指向独立 PostgreSQL 套件。
- 既有 `api_tests`：17 passed、0 failed。
- 完整离线 `cargo test --lib`：281 passed、1 ignored；显式移除 TEST_PG_URL 和 TEST_ACCOUNT_PG_URL，没有执行旧 PostgreSQL 门控用例。
- 既有离线 `cargo test --test api_tests`：17 passed，0 failed。
- 本领域专属 PostgreSQL 套件：1 passed，0 failed、0 ignored。使用临时 postgres:16 容器、独立 UUID schema；真实执行了准备只读、身份精确匹配、权限变化、版本及双方 ABA、禁言到期、冻结撤销、临时/永久/no-op、事务故障回滚、全 Router 鉴权与新旧入口成功、并发重复确认和提交后结果丢弃的模拟。
- 0017 独立新建/重复应用探针通过：重跑不回拨已有版本，quota 更新不增加版本。CI 迁移分类自测通过（18 份迁移均已归类）。
- 新模块 rustfmt 检查、git diff --check 通过。

“响应丢失”是数据库已提交后丢弃返回结果，再使用旧 version 提交的确定性模拟；没有进行真实网络故障压测。未对生产库执行迁移、请求或旧整套 PostgreSQL 集成测试。专属临时容器已停止并自动删除。

## 集成验证（2026-10-24）

与个人通知事务服务合并后，离线 Rust 库 284 项返回成功，前端 62 组脚本及 180 项单测通过。
本机未配置 `TEST_PG_URL`，此结果不代表数据库用例已执行；真实事务测试由标准 PR CI 的临时 PostgreSQL 执行。
删除前端对旧禁言 handler 函数体的写法断言，权限、状态隔离和到期/no-op 行为由数据库测试验证。
