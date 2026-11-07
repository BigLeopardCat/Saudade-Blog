/** Cross-language comment contracts; browser and PostgreSQL suites exercise list behavior. */
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const comp = read('frontend/src/pages/Dashboard/CommentManage/index.tsx');
const api = read('frontend/src/apis/commentAdminApi.ts');
const admin = read('src/routes/comments/admin.rs');
const writes = read('src/routes/comments.rs');
const routes = read('src/routes/mod.rs');
const settings = read('src/routes/web_info.rs');
const shared = read('frontend/src/pages/Dashboard/ContentManage/shared.tsx');
const source = comp + api;
assert.ok(api.includes("http.get('/api/protect/comments',"));
assert.ok(api.includes('http.put(`/api/protect/comments/${id}/audit`, {approved, reason}, {signal})'));
assert.ok(api.includes('http.delete(`/api/protect/comments/${id}`, {signal})'));
assert.ok(!source.includes('/api/protect/board'));
assert.ok(admin.includes('pub async fn list_comments_admin'));
for (const field of ['noteId','noteTitle','userId','replyToNickname','createTime','aiResult','aiReason','rejectReason','isDeleted']) {
    assert.ok(admin.includes(`#[serde(rename = "${field}")]`), field);
    assert.ok(api.includes(field), field);
}
for (const key of ['commentAiReviewEnabled','commentManualReviewEnabled']) {
    assert.ok(comp.includes(`'${key}'`));
    assert.ok(settings.includes(`"${key}"`));
    assert.ok(!writes.includes(`"${key}"`));
}
assert.ok(writes.includes('super::web_info::COMMENT_REVIEW_KEYS'));
assert.ok(writes.includes('if c.is_deleted != 0'));
assert.ok(writes.includes('am.approved = Set(if reject { 2 } else { 1 });'));
assert.ok(writes.includes('am.is_deleted = Set(1)'));
assert.ok(comp.includes('COMMENT_REJECT_PRESETS.map'));
assert.ok(comp.includes('maxLength={REJECT_REASON_MAX}'));
assert.ok(comp.includes('disabled: !rejectReason.trim(),'));
assert.ok(shared.includes('export const REJECT_REASON_MAX = 200'));
const boundary = routes.indexOf('let protected_routes = Router::new()');
for (const path of ['/api/protect/comments','/api/protect/comments/{id}/audit','/api/protect/comments/{id}']) {
    assert.ok(routes.indexOf(`"${path}"`) > boundary, path);
}
for (const path of ['/api/public/notes/{id}/comments','/api/public/comments/{id}']) {
    assert.ok(routes.indexOf(`"${path}"`) < boundary, path);
}
assert.ok(routes.includes('delete(comments::delete_my_comment)'));
assert.ok(routes.includes('delete(comments::delete_comment_admin)'));
console.log(`${fileURLToPath(import.meta.url)}: comment wire and permission contracts passed`);
