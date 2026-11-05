const fs = require('fs');
const path = require('path');

const rootDir = process.cwd();
const tempDir = path.join(rootDir, '.lgtv-keys-temp');
const validKey = /^[a-f0-9]{16,}$/i;
const staleRootFiles = ['debug-reconnect.js', 'keys.json.bak', 'commands.json.old'];

function isIpKeyFile(name) {
  return /^\.\d{1,3}(?:\.\d{1,3}){3}\.key$/i.test(name);
}

function isLegacyTempFile(name) {
  return !isIpKeyFile(name) || /\.key\.mac(?:\.key)?$/i.test(name) || /(?:^|[._])(?:wired|wifi)/i.test(name);
}

function isValidKeyValue(value) {
  const trimmed = String(value || '').trim();
  return !!trimmed && trimmed !== '{}' && validKey.test(trimmed);
}

function removeIfExists(filePath, label) {
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    console.log(`[KEYS] removed ${label}: ${path.basename(filePath)}`);
    return true;
  } catch (error) {
    console.warn(`[KEYS] could not remove ${label}: ${path.basename(filePath)} (${error.message})`);
    return false;
  }
}

function cleanStaleRootArtifacts() {
  let removed = 0;

  staleRootFiles.forEach((fileName) => {
    if (removeIfExists(path.join(rootDir, fileName), 'stale root artifact')) {
      removed += 1;
    }
  });

  const backupMatches = fs.existsSync(rootDir)
    ? fs.readdirSync(rootDir).filter((file) => file.endsWith('.bak') || file.endsWith('.old'))
    : [];

  backupMatches.forEach((fileName) => {
    if (removeIfExists(path.join(rootDir, fileName), 'stale backup')) {
      removed += 1;
    }
  });

  return removed;
}

function cleanTempKeys() {
  if (!fs.existsSync(tempDir)) {
    console.log('[KEYS] temp directory not found; nothing to clean');
    return { kept: 0, removed: cleanStaleRootArtifacts() };
  }

  const files = fs.readdirSync(tempDir);
  let removed = cleanStaleRootArtifacts();
  let kept = 0;

  for (const file of files) {
    const filePath = path.join(tempDir, file);
    if (!fs.statSync(filePath).isFile()) continue;

    if (isLegacyTempFile(file)) {
      fs.unlinkSync(filePath);
      removed += 1;
      console.log(`[KEYS] removed legacy temp key: ${file}`);
      continue;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (isValidKeyValue(content)) {
        kept += 1;
        continue;
      }
      fs.unlinkSync(filePath);
      removed += 1;
      console.log(`[KEYS] removed invalid temp key: ${file}`);
    } catch (error) {
      try {
        fs.unlinkSync(filePath);
        removed += 1;
        console.log(`[KEYS] removed unreadable temp key: ${file}`);
      } catch (_) {
        console.warn(`[KEYS] could not remove temp key: ${file}`);
      }
    }
  }

  console.log(`[KEYS] cleanup finished: kept=${kept}, removed=${removed}`);
  return { kept, removed };
}

cleanTempKeys();
