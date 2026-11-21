# Getting started

[Guide](README.md) · [中文：开发约定](../../CONTRIBUTING.md) · [中文：部署入口](../../deploy/README.md)

## Choose development or installation

For a self-hosted installation, choose a fixed release and follow [prebuilt installation](../../deploy/prebuilt.md) or [source-based Compose installation](../../deploy/docker/README.md). Verify manifest/checksums and platform requirements. Docker Engine and Docker Compose 2.30+ are required for the container path. Core-only installation does not need an Agent or model credentials.

The steps below are for an isolated development machine. Do not initialize a production database or run full Rust/frontend builds on a host that also serves production.

## Prerequisites and checkout

Use Git, Rust 1.92+, Node as pinned in [.node-version](../../.node-version), and PostgreSQL 16. Exact dependency versions come from the lockfiles.

```sh
git clone --branch main https://github.com/BigLeopardCat/Saudade-Blog.git
cd Saudade-Blog
cp .env.example .env
```

The default branch is `main`. Existing checkouts should fetch remote updates and refresh their remote default-branch reference. Change local tracking only after checking for a pre-existing local `main`, uncommitted work, and other worktrees; do not reset shared checkouts as a migration shortcut.

## Create a development database

Create a dedicated PostgreSQL database and development role, following the database settings in [CONTRIBUTING](../../CONTRIBUTING.md). Use a database owner/migration role for schema setup; the runtime application role should not own production DDL.

From the repository root, list the baseline and numbered migrations in the supported order:

```sh
python3 scripts/migration/pg/ci_schema_files.py
```

On your **disposable development database**, apply those files in the printed order with `psql -v ON_ERROR_STOP=1`. Do not run this against an existing production database. The baseline is not a substitute for an upgrade plan, and optional fixtures are not production seed data.

## Configure and start

Edit `.env` with a development `DATABASE_URL`, a random development-only `JWT_SECRET`, and your local site/API addresses. Consult [the configuration map](../configuration.md) and [.env.example](../../.env.example) for exact fields. Do not reuse production credentials or commit this file.

Start the backend:

```sh
cargo run
```

In a second terminal:

```sh
cd frontend
npm ci
npm run fetch:widget
npm run vendor:live2d
npm run dev
```

`fetch:widget` verifies the pinned Agent frontend source and subtree hashes. Run it before `vendor:live2d`, which obtains the separately licensed renderer runtime. The Vite development server proxies API requests to the local backend. Use its printed local address to inspect the UI.

## Enable the Agent separately

Start with the core blog. Then use the [Agent setup guide](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/docs/en/getting-started.md) and [host configuration](../configuration.md) to connect a private Python service. Configure matching service assertions and independent confirmation signing, a model provider, and the Agent's dedicated state database.

The Agent must not receive the host's `JWT_SECRET`, `BLOG_DELEGATION_SECRET`, or device signing key. Browser requests go through host authentication. Keep internal Agent ports private and use different credentials/databases for development, CI, and production.

## Verification and operations

The [contribution guide](../../CONTRIBUTING.md) defines Rust, PostgreSQL, TypeScript, component, and browser checks. [Frontend testing](../frontend-testing.md) describes API interception and synthetic data. Missing test DSNs do not establish database correctness; use a disposable instance and report skips.

Production setup additionally requires a public URL/TLS, private persistent state, the first administrator, backup/restore planning, and version verification. Follow the versioned [Compose guide](../../deploy/docker/README.md), [account-isolation guide](../../deploy/service-isolation.md), and [compatibility guide](../compatibility-and-upgrades.md). These English development steps are not a complete production runbook.
