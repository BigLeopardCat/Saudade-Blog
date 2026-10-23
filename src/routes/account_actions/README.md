# 账号管理

| 文件 | 职责 |
| --- | --- |
| `model.rs` | 严格输入契约和允许对外展示的业务快照 |
| `targets.rs` | 精确身份解析、权威授权、北京时间、只读计划和版本 |
| `transaction.rs` | 行锁后重验、指定字段更新、结果核验和事务内系统通知 |
| `mod.rs` | 管理员 HTTP 接线、事务边界、旧入口共享服务 |
| `postgres_tests.rs` | 隔离 PostgreSQL 事务、版本、路由行为验证 |
| `tests.rs` | 离线权限/输入/完整 Router 验证 |

完整协议、业务政策和部署顺序见 [接口文档](../../../docs/account-actions.md)。身份与令牌解析复用 `auth_jwt`，权限复用 `authz`；不接入自然语言规划或全局提示词。
