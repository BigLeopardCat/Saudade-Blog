# Engineering cases: the business host

[Guide](README.md) · [中文版](../engineering-cases.md)

The blog is both a usable content application and the Agent's business boundary. These cases explain host-owned decisions. The Agent's [companion cases](https://github.com/BigLeopardCat/saudade-blog-agent/blob/main/docs/en/engineering-cases.md) cover full-document synthesis, write recovery, and semantic evaluation.

## 1. Review an Agent edit without overwriting concurrent work

**Trigger.** An author has unsaved changes in the editor while the Agent proposes a revision based on an earlier text snapshot. Applying it unconditionally can discard local work; silently saving it conflates a proposal with an authorized business update.

**Decision.** Keep three states distinct: the browser's working copy, the stored draft, and the published article. Treat Agent collaboration as a proposed change that the editor reviews/adopts. Validate the applicable base/version before accepting a change, and retain the normal host save/publish flow with optimistic version checks.

Sending a client operation is not proof it was applied. The Agent waits for bounded feedback with completed, failed, timeout, or unknown outcomes. An editor acknowledgment concerns the working copy; only a valid host response establishes persistence. Permissions and article ownership remain host checks even when the model sees the editor page.

**Tradeoff.** Explicit review and conflict handling add interaction, but prevent silent data loss and separate model suggestions from publication. Different content operations have their own confirmation path: for example, article-summary changes use an approval card rather than pretending every field uses the body editor workflow.

**Inspect.** [Collaboration contract](../article-collaboration.md), [article actions](../article-actions.md), [editor integration](../../frontend/src/pages/Dashboard/Notes/NewNotes/index.tsx), and [security boundaries](../security-boundary.md). Frontend/component/browser checks exercise UI feedback with synthetic APIs; PostgreSQL/API checks separately cover host persistence and version conflicts. Use [code reading](../code-reading.md) and [frontend test guidance](../frontend-testing.md) for the maintained test entry points.

**Limit.** A correct diff UI does not guarantee a good rewrite. Model quality needs content review, and an applied working-copy change does not prove it has been saved or published.

## 2. Deliver a reproducible host, runtime, and widget combination

**Trigger.** Updating the Python service does not necessarily change the widget; updating the widget does not necessarily require a new Python runtime. Building against whichever sibling checkout happens to be on a developer's machine makes results difficult to reproduce and can combine incompatible protocol versions.

**Decision.** Maintain separate explicit pins. The Agent's host-contract file fixes public host test source. This repository's widget lock fixes the frontend source commit and both resource subtree hashes. Its Compose Agent lock independently fixes runtime source. Only change a pin when adopting the corresponding behavior, and reference pushed, retrievable full commits.

For releases, record exact source revisions and package checksums. Verify actual installation, configuration reuse, and database/upload restoration in disposable CI environments. Prebuilt native archives declare their platform/ABI requirements, while container archives package a tested image combination. A successful artifact build is not a production rollout.

**Tradeoff.** Explicit pins require coordinated compatibility review, but allow a documentation-only or Python-only change without mechanically replacing the widget. Cross-layer protocol changes still require checking Rust, Python, and the browser together. Neither the lock nor a green PR proves what is running: compare frontend build information, backend artifact provenance, and Agent `/version` separately.

**Inspect.** [Compatibility](../compatibility-and-upgrades.md), [widget lock](../../frontend/widget.lock.json), [Compose runtime lock](../../deploy/docker/agent.lock.json), [release packaging](../../deploy/package_release.py), and [container rehearsal workflow](../../.github/workflows/container.yml). Full builds and recovery rehearsals run in CI rather than consuming the production machine's memory and bandwidth.

**Limit.** A clean install and restore test does not establish sustained availability under real traffic. Release evidence must identify tested scope, untested features, known issues, and actual deployment status. Product UI language is also independent from documentation language.
