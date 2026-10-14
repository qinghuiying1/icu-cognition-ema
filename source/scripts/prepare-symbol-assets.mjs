import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const taskRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Resolve through the assessment package so pnpm's transitive package layout
// does not require assuming a top-level @m2c2kit/core installation.
const assessmentRoot = path.resolve(path.dirname(require.resolve('@m2c2kit/assessment-symbol-search')), '..');
const assessmentRequire = createRequire(path.join(assessmentRoot, 'package.json'));
const coreRoot = path.resolve(path.dirname(assessmentRequire.resolve('@m2c2kit/core')), '..');
const expected = { assessment: '0.8.35', core: '0.3.37', wasm: '0.41.1' };
const assessmentPackage = JSON.parse(fs.readFileSync(path.join(assessmentRoot, 'package.json'), 'utf8'));
const corePackage = JSON.parse(fs.readFileSync(path.join(coreRoot, 'package.json'), 'utf8'));
if (assessmentPackage.version !== expected.assessment || corePackage.version !== expected.core) {
  throw new Error('符号搜索或Core依赖版本变更，须先复核素材与计时实现。');
}
const target = path.join(taskRoot, 'public', 'assets', 'symbol-search');
fs.mkdirSync(target, { recursive: true });
const records = [];
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function copyOne(source, relativeTarget, owner) {
  const output = path.join(target, relativeTarget);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(source, output);
  const bytes = fs.readFileSync(output);
  records.push({ file: relativeTarget.split(path.sep).join('/'), bytes: bytes.length,
    sha256: hash(bytes), owner });
}
function copyTree(source, relativeTarget, owner) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name);
    const destination = path.join(relativeTarget, entry.name);
    if (entry.isDirectory()) copyTree(sourceEntry, destination, owner);
    else if (entry.isFile()) copyOne(sourceEntry, destination, owner);
  }
}
copyTree(path.join(assessmentRoot, 'assets', 'images'), 'images', '@m2c2kit/assessment-symbol-search@0.8.35');
copyTree(path.join(assessmentRoot, 'assets', 'fonts'), 'fonts', '@m2c2kit/assessment-symbol-search@0.8.35');
copyOne(path.join(coreRoot, 'assets', `canvaskit-${expected.wasm}.wasm`),
  `canvaskit-${expected.wasm}.wasm`, '@m2c2kit/core@0.3.37');
copyOne(path.join(assessmentRoot, 'LICENSE'), 'LICENSE-symbol-search.txt', '@m2c2kit/assessment-symbol-search@0.8.35');
copyOne(path.join(coreRoot, 'LICENSE'), 'LICENSE-core.txt', '@m2c2kit/core@0.3.37');
records.sort((a,b) => a.file.localeCompare(b.file));
const manifest = { schemaVersion: 1, packages: {
  assessment: { version: expected.assessment, license: assessmentPackage.license,
    source: 'https://github.com/m2c2-project/m2c2kit/tree/main/packages/assessment-symbol-search' },
  core: { version: expected.core, license: corePackage.license,
    source: 'https://github.com/m2c2-project/m2c2kit/tree/main/packages/core' },
}, wasmVersion: expected.wasm, files: records };
fs.writeFileSync(path.join(target, 'material-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${records.length} Symbol Search assets with SHA-256 and SDK licenses.`);
