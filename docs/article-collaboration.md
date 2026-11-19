# 文章协作编辑

管理员打开文章编辑器后，可让 Agent 读取当前工作副本，建议修改标题和正文，准备摘要概述，以及打开发布流程。普通聊天不默认携带整篇正文。

## 审阅与保存

- 标题和正文使用真实 `diff` 结果展示，删除红色、新增绿色。建议本身不覆盖原文，逐段或整批采纳后通过编辑器事务写入，可撤销。
- 摘要由 `prepare_article_summary` 产生聊天确认卡，批准后才覆盖概述字段；不展示正文式差异。
- `prepare_article_publication` 在现有编辑页保存当前草稿并打开发布审阅。用户无需退出编辑器；最终发布仍由发布流程检查并确认。
- 本地采纳、服务器保存和正式发布是不同状态。Agent 不能把浏览器已接收命令说成文章已发布。

## 并发与恢复

工具读取返回编辑器标识、本地修订和有界片段；修改引用刚读取的版本。继续输入、切换文章或刷新后，旧提案不能覆盖新内容，需要重新读取。

`GET /api/protected/draft/editor/{id}` 返回原文、草稿与版本；保存/发布携带版本条件。过期自动保存、旧发布与并发覆盖返回冲突，不能静默成功。正文修改使用唯一匹配的 `old_text` / `new_text`，不做模糊替换。

客户端动作通过 Agent 的 LangGraph interrupt 等待有界回报；工具标识用于断点重放，独立读取使用新标识。回报不授予业务权限，也不是数据库事务凭据。

## 保存、审阅与发布

```mermaid
sequenceDiagram
    actor User as 作者
    participant Editor as 浏览器编辑器
    participant Agent as 可选 Agent
    participant Host as Rust 业务后端
    participant DB as PostgreSQL
    participant Corpus as 公开语料消费者
    User->>Editor: 编辑文章
    Editor->>Host: 携带版本的自动保存
    Host->>DB: 新建草稿或保存公开文章的独立修改稿
    opt 请求 Agent 润色
        Editor->>Host: 提交文章协作请求
        Host->>Agent: 鉴权后转发请求
        Agent-->>Host: 正文或标题修改建议
        Host-->>Editor: 转发修改建议
        Editor-->>User: 展示差异并等待采纳
        User->>Editor: 采纳或拒绝建议
    end
    User->>Editor: 保存并选择发布
    Editor->>Host: 当前内容、发布状态与预期版本
    Host->>Host: 当前账号权限和字段校验
    Host->>DB: 事务锁定根文章并核对版本
    alt 版本冲突
        Host-->>Editor: 拒绝覆盖，要求重新读取
    else 版本有效且事务提交成功
        Host->>DB: 提交发布变更
        Host-->>Editor: 已保存的文章结果
        Corpus->>Host: 后续获取公开语料快照
        Host-->>Corpus: 仅公开且已发布的根文章
    end
```

采纳编辑器建议、自动保存草稿、发布文章、更新 RAG 索引是四个不同事实。
Agent 的客户端回报不能代替发布回执。语料消费者仍须完整抓取、核验版本并成功发布索引，
不能在文章发布后立即声称检索已经更新；详见[语料接口](rag-corpus-api.md)。

## 回归

Rust/PostgreSQL 验证版本条件和保存/发布冲突。真实 ByteMD 浏览器测试验证标题/正文差异、采纳、原生撤销、摘要确认后应用、继续输入、账号切换与发布对话框。Agent 使用真实框架恢复工具调用，不能仅用桩最终回答替代链路验证。
