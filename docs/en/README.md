# Technical guide

[English project overview](../../README.md) · [中文文档导航](../README.md)

| Goal | Entry |
| --- | --- |
| Understand the host and optional Agent boundary | [Architecture](architecture.md) |
| Develop locally or choose an installation path | [Getting started](getting-started.md) |
| Examine concrete design decisions and checks | [Engineering cases](engineering-cases.md) |
| Use the current Chinese UI | [User guide](../user-guide.md) and [Wiki source tutorials](../wiki/Home.md) |
| Configure or operate the system | [Configuration](../configuration.md), [deployment](../deployment-and-ops.md), and [troubleshooting](../troubleshooting.md) |
| Assess a host/Agent/widget version combination | [Compatibility and upgrades](../compatibility-and-upgrades.md) |

English guides explain the core execution and development paths. Detailed configuration, business endpoints, migration requirements, and operational contracts remain in their Chinese references. Keep corresponding explanations aligned when behavior changes; avoid copying defaults or historical scores into multiple pages.

The [Agent English guide](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/docs/en/README.md) owns model execution, runtime memory, context budgets, retrieval, semantic evaluation, and scheduling. This repository owns business authentication, persisted editor state, transactions, and host deployment.

Read documentation at the revision you use. Source, published packages, and production processes can have different versions. Public pages and chat controls share an English/Chinese language switch; authored content is not automatically translated, and the administration interface is not fully translated.
