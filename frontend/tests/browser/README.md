# Browser regression tests

Run from `frontend`:

```sh
npm ci
npx playwright install --with-deps chromium
# Linux CI also installs fonts-noto-cjk.
npm run typecheck:browser
npm run test:browser
```

These are browser integration tests of real components/modules, not full deployed
application E2E tests. The shared sandbox adapts PR #34's esbuild/loopback approach;
it builds current source directly, serves an in-memory allowlist, and always closes
the server. It does not copy/patch product source or manufacture product DOM.
Fixtures mount real React/Ant Design components; Axios tests use the real client
and XHR. All API responses and telemetry are intercepted. Any unanticipated network
request or uncaught page error fails the test. Never point these suites at a real
backend or load production credentials.

Chromium is fixed to zh-CN / Asia/Shanghai. Linux runs use Noto Sans CJK SC; install
the same font before adding visual baselines. This first batch asserts behavior,
not exact glyph geometry. Debounce/redirect timing uses Playwright's clock, request
and DOM assertions auto-wait, and in-flight mutation races use an explicit response
gate. Do not add arbitrary sleeps. Workers are limited to one for this low-resource
repository. Failures retain screenshots and traces under ignored `test-results/`;
HTML reports are under ignored `playwright-report/`.

First migration coverage:

| Source | TS replacement | Contract |
| --- | --- | --- |
| `axios-auth.test.py` | `axios-auth.spec.ts` | 200 success, Bearer normalization and guest headers; 401 rejection, credential removal, feedback and delayed redirect; 403 rejection without logout |
| `dashboard-announcement-refresh.test.py` | `announcement.spec.ts` | Initial/remount refresh, visible focus refresh and event deduplication, hidden suppression, unmount cleanup, no-selection delete; extended with business/transport save failures preserving input, in-flight click protection and successful retry |

Other Python browser suites remain until their useful scenarios have an executed
replacement. PR #34 is a source of reviewed scenarios, not a bulk import target.

The tag/category smoke specs additionally mount each real management page with
its own Sass plus Dashboard's global CSS, a real Redux store with thunk middleware,
and the dashboard's primary color / lg breakpoint context. At 1280px and 390px,
they verify the editing resource ID/level, failed writes preserving fields,
successful retry, and absence of horizontal page overflow. These component
previews do not exercise the dashboard shell or claim complete theme coverage.
Set `ADMIN_PREVIEW_DIR` to an absolute directory to save review screenshots outside
the repository; normal CI only captures failures. `tag-manage.test.py` has been
retired: the tag RTL suite covers independent editing/checking, failures, missing
edit targets, cascades and mixed-level deletion, while the browser smoke validates
actual presentation and HTTP payloads. The `tag-tree.test.mjs` cross-level data
contracts remain. `admin-mutation-results.test.mjs` has also been retired in favor
of real category RTL and announcement browser cases. Announcement coverage includes
create/edit failure preserving content and suppressing publication events, failed
delete retaining row selection, confirmed retry, and in-flight duplicate clicks.

Register per-test API routes in the test body after requesting `sandboxURL` so
they override the sandbox's default network-deny handler. A `beforeEach` must
explicitly depend on `sandboxURL` if it needs to register network routes.

`public-header.spec.ts` mounts the real public header with its production Sass,
App layout, and Redux reducers. It checks direct-load and refresh geometry at
1440px and 390px before any dashboard route is loaded, then injects the real
Dashboard/overview CSS to verify that visiting a lazy route cannot restyle the
public header. It also checks drawer open/close, scroll locking, and cleanup when
crossing back to the desktop breakpoint. The homepage content placeholder only
measures header flow; the header and drawer implementations are never copied.
