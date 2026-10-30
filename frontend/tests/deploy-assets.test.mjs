/** Execute the deployment cleanup in an isolated filesystem, without a server or secrets. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = readFileSync(new URL('../../scripts/deploy/deploy_from_r2.sh', import.meta.url), 'utf8');
const body = script.match(/python3 - <<'PYEOF3'.*?\n([\s\S]*?)\nPYEOF3/)[1];
const root = mkdtempSync(path.join(tmpdir(), 'deploy-assets-'));
try {
  mkdirSync(path.join(root, 'frontend/dist/vendor'), { recursive: true });
  mkdirSync(path.join(root, 'logs'));
  const write = (name, age = 0) => {
    const file = path.join(root, 'frontend/dist', name);
    writeFileSync(file, name);
    const time = new Date(Date.now() - age * 3600_000);
    utimesSync(file, time, time);
    return file;
  };
  write('index.html');
  const retained = ['vendor/Analytics-Abcd1234.js', 'old-Ab_cd-12.css'];
  const removed = ['vendor/Expired-Abcd1234.js', 'plain.js', 'private.png'];
  retained.forEach(name => write(name, 2));
  write(removed[0], 25);
  removed.slice(1).forEach(name => write(name));
  const info = write('build-info.json');
  const outside = path.join(root, 'outside.js');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, path.join(root, 'frontend/dist/linked.js'));
  const manifest = path.join(root, 'logs/.deploy_manifest.txt');
  const run = () => spawnSync('python3', ['-c', body], { cwd: root, encoding: 'utf8' });
  writeFileSync(manifest, 'frontend/dist/index.html\n');
  assert.notEqual(run().status, 0);
  removed.forEach(name => assert.ok(existsSync(path.join(root, 'frontend/dist', name))));
  writeFileSync(manifest, ['frontend/dist/index.html', ...Array.from({ length: 50 }, (_, i) => `frontend/dist/current-${i}`)].join('\n'));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  retained.forEach(name => assert.ok(existsSync(path.join(root, 'frontend/dist', name))));
  removed.forEach(name => assert.equal(existsSync(path.join(root, 'frontend/dist', name)), false));
  assert.ok(existsSync(info) && existsSync(outside));
  console.log('PASS: current assets, 24-hour hashed chunks, manifest guard and symlink boundaries');
} finally {
  rmSync(root, { recursive: true, force: true });
}
