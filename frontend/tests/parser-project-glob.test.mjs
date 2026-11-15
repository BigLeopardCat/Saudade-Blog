import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as parser from '@typescript-eslint/typescript-estree';

const require = createRequire(import.meta.url);
const parserRequire = createRequire(require.resolve('@typescript-eslint/typescript-estree'));
const installed = parserRequire('minimatch/package.json').version;
assert.ok(Number(installed.split('.')[0]) >= 11, `Unsafe parser glob dependency: ${installed}`);

const root = mkdtempSync(path.join(tmpdir(), 'parser-glob-'));
try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'included.ts'), 'export {};');
    writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {strict: true}, include: ['src/**/*.ts'],
    }));
    const source = 'const answer: number = 42;';
    const filePath = path.join(root, '.hidden.ts');
    writeFileSync(filePath, source);
    const options = {
        filePath, tsconfigRootDir: root,
        projectService: {allowDefaultProject: ['*.ts']},
    };
    const result = parser.parseAndGenerateServices(source, options);
    assert.equal(result.ast.body[0].type, 'VariableDeclaration');
    assert.ok(result.services.program, 'Hidden TypeScript files matched with dot:true retain type services');
    const excluded = path.join(root, 'excluded.js');
    writeFileSync(excluded, 'const answer = 42;');
    assert.throws(() => parser.parseAndGenerateServices('const answer = 42;', {
        ...options, filePath: excluded,
    }), /not found|allowDefaultProject/i, 'Unmatched files must not enter the default project');
    console.log('Parser project-service glob compatibility and safe minimatch version verified.');
} finally {
    parser.clearCaches();
    rmSync(root, {recursive: true, force: true});
}
