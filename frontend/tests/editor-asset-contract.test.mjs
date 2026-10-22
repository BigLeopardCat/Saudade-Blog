// Keep the editor's upload/gallery wiring contract until a real editor integration replaces it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editor = readFileSync(new URL('../src/components/Editor/index.tsx', import.meta.url), 'utf8');
assert.match(editor, /import\s*\{\s*encodeAssetUrl\s*\}/);
assert.match(editor, /appendBlock\(`!\[\]\(\$\{encodeAssetUrl\(url\)\}\)`\)/);
assert.match(editor, /url:\s*encodeAssetUrl\(response\.data\.data\)/);
assert.doesNotMatch(editor, /appendBlock\(`!\[\]\(\$\{url\}\)`\)/);
console.log('editor gallery and upload destinations use the shared URL encoder');
