const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function createScenario() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtv-cleanup-'));
  const tempDir = path.join(tempRoot, '.lgtv-keys-temp');
  fs.mkdirSync(tempDir, { recursive: true });

  fs.writeFileSync(path.join(tempDir, '.10.0.0.10.key'), 'a1b2c3d4e5f60718293a4b5c6d7e8f90', 'utf8');
  fs.writeFileSync(path.join(tempDir, '.10.0.0.11.key'), '{"junk":true}', 'utf8');
  fs.writeFileSync(path.join(tempRoot, 'keys.json.bak'), 'stale backup', 'utf8');
  fs.writeFileSync(path.join(tempRoot, 'debug-reconnect.js'), 'old debug file', 'utf8');

  return { tempRoot, tempDir };
}

test('cleanup-temp-keys removes stale backup/debug artifacts and invalid temp keys', () => {
  const { tempRoot, tempDir } = createScenario();

  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'cleanup-temp-keys.js')], {
    cwd: tempRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(tempDir, '.10.0.0.11.key')), false);
  assert.equal(fs.existsSync(path.join(tempRoot, 'keys.json.bak')), false);
  assert.equal(fs.existsSync(path.join(tempRoot, 'debug-reconnect.js')), false);
  assert.equal(fs.existsSync(path.join(tempDir, '.10.0.0.10.key')), true);
});
