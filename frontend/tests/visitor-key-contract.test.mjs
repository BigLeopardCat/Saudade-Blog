// Cross-language API contract stays in Node; visitor behavior lives in Vitest TS.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const backend = readFileSync(new URL('../../src/routes/note_stats.rs', import.meta.url), 'utf8');
const frontend = readFileSync(new URL('../src/utils/visitorKey.ts', import.meta.url), 'utf8');
const backendHeader = backend.match(/const VISITOR_HEADER: &str = "([^"]+)"/);
const frontendHeader = frontend.match(/export const VISITOR_HEADER = '([^']+)'/);
assert.ok(backendHeader, 'backend visitor header must exist');
assert.ok(frontendHeader, 'frontend visitor header must exist');
assert.equal(frontendHeader[1].toLowerCase(), backendHeader[1].toLowerCase());
assert.match(backend, /const VISITOR_MIN: usize = 8;/);
assert.match(backend, /const VISITOR_MAX: usize = 64;/);
assert.match(backend, /is_ascii_alphanumeric\(\) \|\| b == b'-' \|\| b == b'_'/);
console.log('visitor header and whitelist agree across the HTTP boundary');
