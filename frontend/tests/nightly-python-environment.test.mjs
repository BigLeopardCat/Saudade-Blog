/** The nightly runner uses one isolated Python command and never falls back to host packages. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const run = (command, args, options = {}) => spawnSync(command, args, {
    encoding: 'utf8', timeout: 30_000, ...options,
})

test('nightly preflight, suites and cleanup use isolated packages; failures cannot use system Python', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'nightly-python-'))
    try {
        const virtual = path.join(fixture, 'isolated')
        const created = run('python3', ['-m', 'venv', '--without-pip', virtual])
        assert.equal(created.status, 0, created.stderr)
        const python = path.join(virtual, 'bin/python')
        const located = run(python, ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'])
        assert.equal(located.status, 0, located.stderr)
        const site = located.stdout.trim()
        const requirements = readFileSync(path.join(repo, 'frontend/tests/requirements.txt'), 'utf8')
        const pins = Object.fromEntries(requirements.split('\n').filter(line => line && !line.startsWith('#'))
            .map(line => line.split('==')))
        for (const [distribution, module] of [['Pillow', 'PIL'], ['playwright', 'playwright']]) {
            mkdirSync(path.join(site, module), { recursive: true })
            writeFileSync(path.join(site, module, '__init__.py'), '')
            const metadata = path.join(site, `${distribution}-${pins[distribution]}.dist-info`)
            mkdirSync(metadata)
            writeFileSync(path.join(metadata, 'METADATA'), `Name: ${distribution}\nVersion: ${pins[distribution]}\n`)
        }
        const suites = path.join(fixture, 'frontend/tests')
        mkdirSync(suites, { recursive: true })
        mkdirSync(path.join(fixture, 'scripts'))
        writeFileSync(path.join(suites, 'requirements.txt'), requirements)
        const probe = `import importlib.metadata, json, pathlib, sys\nimport PIL\npathlib.Path(${JSON.stringify(path.join(fixture, 'suite.json'))}).write_text(json.dumps({"prefix":sys.prefix,"isolated":sys.prefix != sys.base_prefix,"Pillow":importlib.metadata.version("Pillow"),"PIL_path":PIL.__file__}))\n`
        writeFileSync(path.join(suites, 'environment.py'), probe)
        writeFileSync(path.join(fixture, 'scripts/prune_sandbox_tmp.py'),
            `import pathlib, sys\npathlib.Path(${JSON.stringify(path.join(fixture, 'prune-prefix'))}).write_text(sys.prefix)\n`)
        const poison = path.join(fixture, 'host-packages')
        mkdirSync(poison)
        writeFileSync(path.join(poison, 'PIL.py'), 'raise RuntimeError("host package must not load")\n')
        const shellEnvironment = path.join(fixture, 'shell-environment')
        writeFileSync(shellEnvironment, 'pgrep() { return 1; }\n')
        const executable = path.join(fixture, 'uv-fixture.mjs')
        writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
appendFileSync(process.env.UV_CALLS, JSON.stringify(args) + '\\n')
if (process.env.FAIL_UV === '1') process.exit(23)
if (args[args.indexOf('--with-requirements') + 1] !== process.env.EXPECT_REQUIREMENTS) process.exit(26)
const at = args.indexOf('python')
if (at < 0) process.exit(24)
const result = spawnSync(process.env.ISOLATED_PYTHON, args.slice(at + 1), { stdio: 'inherit' })
process.exit(result.status ?? 25)
`, { mode: 0o755 })
        const env = { ...process.env, PROJECT_DIR: fixture, UV_BIN: executable,
            EXPECT_REQUIREMENTS: path.join(suites, 'requirements.txt'),
            ISOLATED_PYTHON: python, UV_CALLS: path.join(fixture, 'uv-calls'),
            BASH_ENV: shellEnvironment, PYTHONPATH: poison,
            LOG: path.join(fixture, 'nightly.log'), MARK: path.join(fixture, 'failed'),
            SANDBOX_TMP: path.join(fixture, 'sandboxes'), DRY: '0' }
        const invoke = extra => run('bash', [path.join(repo, 'scripts/nightly_sandboxes.sh')], {
            env: { ...env, ...extra },
        })
        const passed = invoke({})
        assert.equal(passed.status, 0, readFileSync(env.LOG, 'utf8') + passed.stderr)
        const result = JSON.parse(readFileSync(path.join(fixture, 'suite.json'), 'utf8'))
        assert.equal(result.prefix, virtual)
        assert.equal(result.isolated, true)
        assert.equal(result.Pillow, pins.Pillow)
        assert.ok(result.PIL_path.startsWith(virtual + path.sep))
        assert.equal(readFileSync(path.join(fixture, 'prune-prefix'), 'utf8'), virtual)
        const calls = readFileSync(env.UV_CALLS, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        assert.equal(calls.length, 3)
        for (const args of calls) {
            assert.ok(args.includes('--no-project') && args.includes('--isolated'))
            assert.equal(args[args.indexOf('--with-requirements') + 1], path.join(suites, 'requirements.txt'))
            assert.equal(args[args.indexOf('python') + 1], '-I')
        }
        assert.equal(existsSync(env.MARK), false)
        const portableScript = path.join(fixture, 'scripts/nightly_sandboxes.sh')
        writeFileSync(portableScript, readFileSync(path.join(repo, 'scripts/nightly_sandboxes.sh')))
        const portableEnvironment = { ...env }
        delete portableEnvironment.PROJECT_DIR
        const portable = run('bash', [portableScript], {
            cwd: tmpdir(), env: portableEnvironment,
        })
        assert.equal(portable.status, 0, readFileSync(env.LOG, 'utf8') + portable.stderr)
        assert.equal(JSON.parse(readFileSync(path.join(fixture, 'suite.json'), 'utf8')).prefix, virtual)
        rmSync(path.join(fixture, 'suite.json'))
        const failed = invoke({ FAIL_UV: '1' })
        assert.equal(failed.status, 1)
        assert.equal(existsSync(env.MARK), true)
        assert.equal(existsSync(path.join(fixture, 'suite.json')), false)
        const callsBeforeDry = readFileSync(env.UV_CALLS, 'utf8')
        const dry = invoke({ FAIL_UV: '1', DRY: '1' })
        assert.equal(dry.status, 0)
        assert.equal(readFileSync(env.UV_CALLS, 'utf8'), callsBeforeDry)
        assert.equal(existsSync(env.MARK), true)
    } finally {
        rmSync(fixture, { recursive: true, force: true })
    }
})
