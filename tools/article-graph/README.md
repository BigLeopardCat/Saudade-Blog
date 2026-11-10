# 文章图谱构建

可选离线工具。博客启动、发布和普通检索不需要安装本工具、Agent 或向量扩展。
图谱使用已经发布的 `rag.snapshots` / `rag.members` / `rag.embeddings`；构建不请求模型，
不产生第二份向量缓存。词节点由公开文章中的词语关联到文档向量，三维位置仅用于探索。

## 构建与发布

在博客仓根目录执行，使用 Python 3.12+ 与 uv：

```sh
uv run --locked --project tools/article-graph python tools/article-graph/build.py \
  --site https://example.com --out /var/lib/saudade-blog/article-graph
```

从私有环境加载 `DATABASE_URL`（博客数据库）与 `GRAPH_VECTOR_DSN`（向量数据库只读角色）。
`GRAPH_VECTOR_COLLECTION` 默认 `blog-public`。不自动读取相邻 Agent 的配置文件。
工具依赖使用本目录的锁文件，不进入 Rust 服务或 Agent 的 Python 环境。

向量角色仅需数据库连接、`rag` schema 的 USAGE，以及上述三张表的 SELECT；
无 CREATE、INSERT、UPDATE 或 DELETE 权限。工具和 Rust 查询均启用只读事务。
博客查询与建图使用同一个向量来源和 collection；构建只使用与当前公开根文章相交的部分。
每篇文章抽词最多读取正文前 20,000 字符；输入最多 2,000 篇文章、五百万向量元素，
输出最多 600 个词节点，PCA 数值线程限制为 1。

发布先写不可变 `graph-<version>.js` 和私有 `source-<version>.json`，最后原子替换 manifest。
source 绑定向量快照指纹、维度、公开文章版本及词到文章的映射；公开路由不能访问它。
博客运行账号需读取输出目录；构建账号负责写入，不给 Web 服务写权限。
文章撤公开或编辑后，旧图拒绝继续提供结果，重新构建后生效。
无产物时前端仍可显示可识别的静态示例，普通页面不受影响。

## 查询与降级

可选配置 `GRAPH_EMBEDDING_BASE_URL`、`GRAPH_EMBEDDING_MODEL`、`GRAPH_EMBEDDING_API_KEY`，
使用与快照相同的 OpenAI-compatible embedding 空间。Rust 直接调用 embedding 服务，
再由 pgvector 排序文档并映射图中的词，响应标为 `mode=document_vectors`。
这表示相关文档的语义匹配，不宣称每个词都有独立生成的词向量。

没有向量库、服务失败、快照已变化或 embedding 空间不匹配时，响应显式标为 `mode=lexical`，
前端展示关键词匹配。自定义 profile 需模型部署导出的查询契约：在模型资产准备时执行
`python -m scripts.prepare_embedding_assets --directory /opt/embedding --model bge-q8 --verify-only --export-query-contract /opt/embedding/query`。
该离线命令来自嵌入模型部署工具，博客运行和构建均不导入 Agent。
构图时通过 `--embedding-contract /opt/embedding/query/query-profile-<摘要>.json`
或 `GRAPH_EMBEDDING_CONTRACT` 指向命令实际输出的路径，无须手填摘要、prefix 或 tokenizer 版本。
工具核验原始 canonical payload 摘要与 PG profile 相同、tokenizer SHA 相同，再与图谱同代发布。
Rust 使用该契约添加查询前缀、按需 NFC 正规化，通过同一 llama.cpp `/tokenize` 计算包括特殊 token 的真实预算，
通过后才调用 embeddings。计数端点失败或不兼容则明确降级，不擅自省略 profile 校验。

## 测试

```sh
uv run --locked --project tools/article-graph python -m unittest discover -s tools/article-graph -p 'test_*.py'
```

测试使用合成文章、向量和临时目录，不访问数据库、模型或部署数据。

生产隔离账号部署时，先由运维创建属组为 `saudade-blog` 的输出目录并启用 setgid
（例如 `install -d -m 2750 -g saudade-blog /var/lib/saudade-blog/article-graph`），
构建账号须属于该组。私有 source 文件使用 0640；不要通过放宽目录到全员可写来解决读权限。
