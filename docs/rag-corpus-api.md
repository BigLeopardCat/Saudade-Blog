# 公开文档读取与 RAG 语料接口

本文说明博客宿主提供的原文读取、语料导出和可见性校验接口。RAG（检索增强生成）的索引发布、向量化配置和检索由 Agent 负责；接口字段使用英文标识符，不限制文章正文的语言。

## 原文读取

`GET /api/public/documents/{type}/{id}/read` 读取一份公开文档，不增加浏览量。
`type` 支持 `note`、`talk`、`board` 和 `announcement`，ID 必须是正数且在 i32 范围内。
文章必须满足下文的公开根文章条件；说说和留言必须匹配对应来源类型且已审核通过。
此接口不提供私有草稿或编辑器中尚未保存的内容。

`offset` 和 `limit` 按所选原始 Markdown 的 Unicode 码点计数。
`limit` 默认 12,000，最大 24,000。可选参数 `section` 用于选择唯一标题或来源章节 ID，
父章节包含其下的子章节。标题重复时返回未解析的空结果，`source=null`，不会任意选择同名章节。
图片保留为原始 Markdown 引用。

成功响应的 `data` 包含 `content`、`contentRevision`、`sectionSchema`、
`readOffset`、`nextOffset`、`totalChars`、`readComplete` 和数量受限的章节列表。
`source` 绑定文档类型、ID、规范内容修订、章节规则版本、所选章节 ID 及精确可见范围。
读完所选章节不代表读完全文。续读或使用 `sN` 形式的章节 ID 时，必须同时传入
`revision=contentRevision` 和 `section_schema=sectionSchema`。
内容或章节规则已变化时返回 409；缺少定位所需版本或读取范围无效时返回 400。
当前章节规则为 `commonmark-top-level-source-v1`。原文超过 4 MiB 时返回 413；
数据不可用、请求无法获准处理或处理超时时返回 503。成功读取使用 `Cache-Control: no-store`。

对于文章，`metadata` 还包含已有的公开作者显示名、头像、文章简介，以及封面地址和
fit、focal、zoom 字段。它复用公开文章的资料投影，不暴露作者 ID、邮箱、角色或凭据。
显示名和简介分别限制为 80 和 2,000 个 Unicode 码点。
URL 超过 2,048 个码点时返回 null，不返回截断后可能无效的 URL 前缀。
每项受长度限制的文本或 URL 都有对应的 `Truncated` 标记。
未知作者保持 null，未填写的简介为空字符串。图片几何参数非有限值或无效时表示未知，不伪造默认值。
只需要元信息的调用方可传入 `limit=1`，无需为此额外请求正文、统计或逐个作者资料。

`GET /api/public/notes/{id}/stats` 独立于正文读取，也不增加浏览量。
它使用相同的公开根文章条件；数据库故障返回 503，不伪装成文章不存在。
公开调用方只应使用其中的计数值；匿名响应中的 `liked=false` 不代表已登录用户的点赞状态。

## 语料导出

`GET /api/public/rag/corpus` 只导出通过 `notes::public_condition` 的记录：
状态为公开/已发布、`is_public=true`，且 `draft_of IS NULL`。
它与公开详情读取复用同一条件，不增加浏览量，也不暴露内部用户 ID。

参数如下：

| 参数 | 含义 |
| --- | --- |
| `limit` | 每页数量，默认 50，允许 1..100 |
| `after` | 以正数文章 ID 表示的排他游标；第一页不传 |
| `revision` | 传入 `after` 时必填，使用第一页返回的 64 字符语料修订值 |

成功响应沿用 `code`、`message`、`data` 外层结构。
`data` 包含 `schema_version=1`、`revision`、`total`、`documents` 和 `next_cursor`。
每份文档包含 `id`、`title`、`content` 和 `revision`，ID 严格递增。
最后一页的 `next_cursor` 为 null。

每份完整序列化文档限制为 4 MiB，整页语料限制为 12 MiB。
PostgreSQL 在传输所选正文前先计算 JSON 大小。
受字节预算影响，一页返回的文档数可能少于 `limit`；只有 `next_cursor=null` 才表示读取结束。
非空游标是本页最后一份文档的 ID。单份文档超限时明确返回 503，不截断，也不静默跳过。
传输调用方允许完整响应外层结构最多占 16 MiB，此限制独立于普通 API 响应预算。

文档修订值是紧凑 UTF-8 JSON 数组 `[title, content]` 的 SHA-256。
语料修订值由 PostgreSQL 的投影代次和已提交变更记录生成，为不透明的 64 字符十六进制串。
调用方只比较该值。即使 `updated_at` 未变化，公开成员或正文实际发生变化时旧修订值也会失效。
迁移重复执行和已提交记录折叠都保留当前修订值。

每次响应都在 PostgreSQL 的 `REPEATABLE READ, READ ONLY` 事务中读取。
后续分页若携带过期修订值，返回 HTTP 409、`code=409`、`message=corpus_revision_changed`。
调用方必须丢弃本次已读取的部分结果，从头重新获取快照。
数据库故障返回 HTTP 503、`code=503`，且不返回文档；游标、修订值或数量格式错误返回 HTTP 400。
成功导出使用 `Cache-Control: no-store`。

调用方发布索引前必须校验：结构版本、每份文档的修订值、稳定的语料修订值和总数、
单调且唯一的 ID、向前推进的游标，以及最终文档数量。
只有成功读完完整快照，才能确认语料为空；不能把错误或不完整分页当成空语料。

宿主负责公开语料契约，Agent 负责索引发布、向量化配置和检索，详见
[Agent RAG 设计](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/docs/rag-design.md)。

## 当前可见性校验

`POST /api/public/documents/validate` 在 Agent 展示检索结果前，对照当前公开语料校验候选文章身份。
请求体为 `{documents:[{type:"note",id,revision}]}`，其中 `revision` 是规范内容哈希。
最多接受 256 条请求记录和 64 个不同 ID。

响应 `data` 包含 `schemaVersion:1`，并为每个请求 ID 返回且仅返回一项，顺序不限：
`{type:"note",id,visible,contentRevision}`。
不存在、已删除或非公开的文章统一返回 `visible:false,contentRevision:null`，
不返回标题、正文或隐藏元信息。可见文章返回当前规范内容哈希，调用方要求它与候选修订值完全一致。
数据库故障、容量耗尽或处理超时返回 503，不返回表示零命中的成功结果。
身份参数格式错误时，在访问数据库前返回 400。
