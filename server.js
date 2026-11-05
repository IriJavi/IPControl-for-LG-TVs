process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const path = require('path');
const express = require('express');
const WebOS = require('lgtv2');
const { DeviceStore, normalizeMac } = require('./src/deviceStore');
const { LGTVManager } = require('./src/lgTvManager');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function logTimeHHMMSS() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}
const baseConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};
console.log = (...args) => baseConsole.log(`[${logTimeHHMMSS()}]`, ...args);
console.warn = (...args) => baseConsole.warn(`[${logTimeHHMMSS()}]`, ...args);
console.error = (...args) => baseConsole.error(`[${logTimeHHMMSS()}]`, ...args);

const PORT = Number(process.env.PORT || 3000);
const DASHBOARD_URL = 'https://6b10-mes.mobis.com/dashboard.do';
const rootDir = __dirname;
const tempKeysDir = path.join(rootDir, '.lgtv-keys-temp');
const keysFilePath = path.join(rootDir, 'keys.json');
const keyResetStatsPath = path.join(rootDir, 'keys-reset-stats.json');
const store = new DeviceStore(rootDir);
const manager = new LGTVManager({ store, rootDir, logger: console });

function ensureTempKeysDir() {
  try {
    fs.mkdirSync(tempKeysDir, { recursive: true });
  } catch (error) {
    console.warn('[KEYS] Could not create the temporary key folder:', error.message);
  }
}

function getTempKeyFilePath(identifier) {
  const raw = String(identifier || 'unknown').trim();
  const mac = raw.includes(':') ? raw.toLowerCase().replace(/[^a-f0-9]/g, '') : '';
  const safeValue = mac || raw.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(tempKeysDir, `.${safeValue}.key`);
}

function migrateLegacyTempKeys() {
  ensureTempKeysDir();
  const legacyFiles = fs.existsSync(rootDir)
    ? fs.readdirSync(rootDir).filter((file) => file.startsWith('.lgtv-keys-temp-'))
    : [];

  legacyFiles.forEach((file) => {
    const sourcePath = path.join(rootDir, file);
    const ip = file.replace(/^\.lgtv-keys-temp-/, '');
    const targetPath = getTempKeyFilePath(ip);
    try {
      if (!fs.existsSync(targetPath)) {
        fs.copyFileSync(sourcePath, targetPath);
      }
      fs.unlinkSync(sourcePath);
    } catch (error) {
      console.warn(`[KEYS] Could not migrate legacy key ${file}: ${error.message}`);
    }
  });
}

const legacyTvs = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'tvs.json'), 'utf8')) || [];
  } catch (error) {
    return [];
  }
})();
legacyTvs.forEach((tv) => store.registerOrUpdate({ ...tv, autoDiscovered: false }));
const tvs = store.listDevices();

let keys = {};
const keyResetStats = {};
const clients = {};
const status = {};
const reconnectTimers = {};
const remoteSockets = {};
const remoteSocketOpening = {};
const pairingRecoveryInProgress = {};

function publicDevice(device) {
  const key = device.mac || device.ip || device.id;
  const statusEntry = manager.getStatus(key);
  const keySaved = !!(device.mac && store.getKey(device.mac));
  const keepAliveState = manager.getDeviceKeepAliveState(device);

  return {
    id: device.id,
    name: device.name,
    ip: device.ip,
    mac: device.mac,
    group: device.group || 'default',
    notes: device.notes || '',
    autoDiscovered: !!device.autoDiscovered,
    lastSeenAt: device.lastSeenAt || statusEntry.lastSeenAt || Date.now(),
    online: !!statusEntry.online,
    keySaved: keySaved || !!statusEntry.keySaved,
    keepAliveActive: !!keepAliveState.active,
    keepAliveRemainingMs: Number(keepAliveState.remainingMs || 0),
  };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeRequest(client, uri, payload, callback) {
  try {
    if (!client) return callback && callback(new Error('Client not available'));
    if (payload !== undefined) return client.request(uri, payload, callback || (() => {}));
    return client.request(uri, callback || (() => {}));
  } catch (error) {
    if (callback) callback(error);
    return null;
  }
}
function isValidStoredKeyValue(value) {
  return typeof value === 'string' && value.trim() !== '{}' && /^[a-f0-9]{16,}$/i.test(value.trim());
}

function loadKeys() {
  ensureTempKeysDir();
  try {
    const parsed = fs.existsSync(keysFilePath) ? JSON.parse(fs.readFileSync(keysFilePath, 'utf8')) : {};
    keys = parsed && typeof parsed === 'object' ? store.normalizeKeyMap(parsed) : {};
  } catch (error) {
    console.error('[KEYS] Error loading keys.json:', error.message);
    keys = {};
  }

  try {
    const files = fs.existsSync(tempKeysDir) ? fs.readdirSync(tempKeysDir) : [];
    files.forEach(file => {
      const filePath = path.join(tempKeysDir, file);
      if (!fs.statSync(filePath).isFile()) return;

      if (/\.key\.mac(?:\.key)?$/i.test(file) || /(?:^|[._])(?:wired|wifi)/i.test(file)) {
        try { fs.unlinkSync(filePath); } catch (error) { /* ignore cleanup errors */ }
        return;
      }

      const ip = file.replace(/^\./, '').replace(/\.key$/, '');
      if (!ip) return;
      try {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        if (isValidStoredKeyValue(raw)) {
          keys[ip] = raw;
        } else {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        // ignore read errors on temp files
      }
    });
  } catch (error) {
    console.warn('[KEYS] Could not load temporary keys:', error.message);
  }

  try {
    const legacyFiles = fs.existsSync(rootDir)
      ? fs.readdirSync(rootDir).filter(file => file.startsWith('.lgtv-keys-temp-'))
      : [];
    legacyFiles.forEach(file => {
      const ip = file.replace(/^\.lgtv-keys-temp-/, '');
      if (!ip) return;
      try {
        const raw = fs.readFileSync(path.join(rootDir, file), 'utf8').trim();
        if (raw && raw !== '{}' && /^[a-f0-9]{16,}$/i.test(raw)) keys[ip] = raw;
      } catch (error) {
        // ignore read errors on temp files
      }
    });
  } catch (error) {
    console.warn('[KEYS] Could not load legacy temporary keys:', error.message);
  }

  const validKeys = {};
  Object.entries(keys).forEach(([ip, key]) => {
    if (typeof key === 'string' && /^[a-f0-9]{16,}$/i.test(key) && key !== '{}') validKeys[ip] = key;
  });
  keys = validKeys;
  console.log(`[KEYS] ${Object.keys(keys).length} keys loaded`);
}
function saveLegacyKeyFile(identifier, keyValue) {
  if (!identifier || !keyValue) return;
  ensureTempKeysDir();
  const tempKeyFile = getTempKeyFilePath(identifier);
  try {
    fs.writeFileSync(tempKeyFile, String(keyValue).trim(), 'utf8');
  } catch (error) {
    console.warn(`[KEYS] Could not save temp key for ${identifier}: ${error.message}`);
  }
}
function saveKeys() {
  const validKeys = store.normalizeKeyMap(keys);
  try {
    if (fs.existsSync(keysFilePath)) fs.copyFileSync(keysFilePath, keysFilePath + '.bak');
    fs.writeFileSync(keysFilePath, JSON.stringify(validKeys, null, 2), 'utf8');
    keys = validKeys;
    Object.entries(keys).forEach(([ip, keyValue]) => saveLegacyKeyFile(ip, keyValue));
    console.log(`[KEYS] Saved ${Object.keys(keys).length} valid keys`);
  } catch (error) {
    console.error('[KEYS] Error saving keys.json:', error.message);
  }
}

function loadKeyResetStats() {
  try {
    if (!fs.existsSync(keyResetStatsPath)) {
      Object.keys(keyResetStats).forEach((key) => delete keyResetStats[key]);
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(keyResetStatsPath, 'utf8')) || {};
    Object.keys(keyResetStats).forEach((key) => delete keyResetStats[key]);
    Object.entries(parsed).forEach(([pairKey, value]) => {
      if (value && typeof value === 'object') {
        keyResetStats[pairKey] = { ...value };
      }
    });
  } catch (error) {
    console.warn('[KEYS] Could not load reset counters:', error.message);
  }
}

function saveKeyResetStats() {
  try {
    fs.writeFileSync(keyResetStatsPath, JSON.stringify(keyResetStats, null, 2), 'utf8');
  } catch (error) {
    console.warn('[KEYS] Could not save reset counter:', error.message);
  }
}

function getDeviceNameForIp(ip) {
  const device = tvs.find((entry) => entry.ip === ip);
  return device?.name || 'Unknown device';
}

function registerKeyReset(ip, keyValue) {
  if (!ip || !keyValue || typeof keyValue !== 'string') return;
  const normalizedKey = keyValue.trim();
  const pairKey = `${ip}::${normalizedKey}`;
  const current = keyResetStats[pairKey] || { ip, key: normalizedKey, resetCount: 0, lastResetAt: null };
  keyResetStats[pairKey] = {
    ip,
    key: normalizedKey,
    resetCount: Number(current.resetCount || 0) + 1,
    lastResetAt: new Date().toISOString(),
  };
  saveKeyResetStats();
}

function getKeyResetCount(ip, keyValue) {
  if (!ip || !keyValue || typeof keyValue !== 'string') return 0;
  const pairKey = `${ip}::${keyValue.trim()}`;
  return Number(keyResetStats[pairKey]?.resetCount || 0);
}
function selectedTvs(targets) {
  const allowed = new Set(tvs.map(tv => tv.ip));
  return tvs.filter(tv => Array.isArray(targets) && targets.includes(tv.ip) && allowed.has(tv.ip));
}
function tvsByGroup(group) { return tvs.filter(tv => tv.group === group); }
function closeClient(ip) {
  try { clients[ip]?.disconnect?.(); } catch (e) {}
  delete clients[ip];
}
function removeRemoteSocket(ip) {
  try { remoteSockets[ip]?.close?.(); } catch (e) {}
  delete remoteSockets[ip];
  delete remoteSocketOpening[ip];
}
function getRemoteSocket(tv, callback) {
  const client = clients[tv.ip];
  if (!client) return callback(new Error(`No client available for ${tv.name}`));
  if (remoteSockets[tv.ip]) return callback(null, remoteSockets[tv.ip]);
  if (remoteSocketOpening[tv.ip]) {
    return setTimeout(() => getRemoteSocket(tv, callback), 50);
  }
  if (typeof client.getSocket !== 'function') return callback(new Error(`getSocket unavailable for ${tv.name}`));

  remoteSocketOpening[tv.ip] = true;
  try {
    client.getSocket('ssap://com.webos.service.networkinput/getPointerInputSocket', (err, sock) => {
      remoteSocketOpening[tv.ip] = false;
      if (err || !sock) {
        delete remoteSockets[tv.ip];
        return callback(err || new Error(`Remote socket is empty for ${tv.name}`));
      }
      remoteSockets[tv.ip] = sock;
      if (typeof sock.on === 'function') {
        sock.on('close', () => removeRemoteSocket(tv.ip));
        sock.on('error', () => removeRemoteSocket(tv.ip));
      }
      callback(null, sock);
    });
  } catch (error) {
    remoteSocketOpening[tv.ip] = false;
    delete remoteSockets[tv.ip];
    callback(error);
  }
}
function getRemoteSocketAsync(tv) {
  return new Promise((resolve, reject) => getRemoteSocket(tv, (err, sock) => err ? reject(err) : resolve(sock)));
}
async function chunkedMove(sock, dx, dy, packetSize = 4) {
  let x = Number(dx) || 0;
  let y = Number(dy) || 0;
  const packet = Math.max(1, Math.abs(Number(packetSize) || 4));
  while (x !== 0 || y !== 0) {
    const sx = Math.sign(x) * Math.min(Math.abs(x), packet);
    const sy = Math.sign(y) * Math.min(Math.abs(y), packet);
    sock.send('move', { dx: sx, dy: sy, down: 0 });
    x -= sx;
    y -= sy;
    await sleep(0);
  }
}
async function pointerAction(tv, action, options = {}) {
  const client = clients[tv.ip];
  if (!client) return { ip: tv.ip, name: tv.name, status: 'error', message: 'Client not initialized' };
  if (!status[tv.ip]?.online) return { ip: tv.ip, name: tv.name, status: 'error', message: 'TV offline' };

  if (action === 'open') {
    return new Promise(resolve => {
      safeRequest(client, 'ssap://system.launcher/open', { target: options.url || DASHBOARD_URL }, err => {
        resolve(err ? { ip: tv.ip, name: tv.name, status: 'error', message: err.message } : { ip: tv.ip, name: tv.name, status: 'ok', action: 'open' });
      });
    });
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const sock = await getRemoteSocketAsync(tv);
      if (action === 'move') {
        await chunkedMove(sock, options.dx, options.dy, options.packetSize);
        return { ip: tv.ip, name: tv.name, status: 'ok', action: 'move' };
      }
      if (action === 'click') {
        sock.send('click', { button: 'LEFT' });
        return { ip: tv.ip, name: tv.name, status: 'ok', action: 'click' };
      }
      if (action === 'back') {
        sock.send('button', { name: 'BACK' });
        return { ip: tv.ip, name: tv.name, status: 'ok', action: 'back' };
      }
      return { ip: tv.ip, name: tv.name, status: 'error', message: 'Action not supported' };
    } catch (error) {
      removeRemoteSocket(tv.ip);
      if (attempt === 1) {
        return { ip: tv.ip, name: tv.name, status: 'error', message: error.message };
      }
    }
  }

  return { ip: tv.ip, name: tv.name, status: 'error', message: 'The pointer action could not be completed' };
}
function captureAndSaveKey(tv, client) {
  const keyValue = typeof client.clientKey === 'string' ? client.clientKey : client.clientKey?.toString?.();
  if (keyValue && /^[a-f0-9]{16,}$/i.test(keyValue) && keyValue !== '{}' && keys[tv.ip] !== keyValue) {
    keys[tv.ip] = keyValue;
    if (tv.mac) keys[tv.mac] = keyValue;
    saveLegacyKeyFile(tv.mac || tv.ip, keyValue);
    saveKeys();
    console.log(`[KEYS] Key saved for ${tv.name}`);
  }
}
function scheduleReconnect(tv, reason = 'close') {
  if (reconnectTimers[tv.ip]) {
    console.log(`[RECONNECT] ${tv.name} (${tv.ip}) | already scheduled | reason: ${reason}`);
    return;
  }
  console.warn(`[RECONNECT] ${tv.name} (${tv.ip}) | retry in 5s | reason: ${reason}`);
  reconnectTimers[tv.ip] = setTimeout(() => {
    delete reconnectTimers[tv.ip];
    closeClient(tv.ip);
    connectTV(tv);
  }, 5000);
}
function shouldReconnectFromError(err) {
  const code = String(err?.code || err?.message || '').toUpperCase();
  return ['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ENETUNREACH'].some(x => code.includes(x));
}
function clearStoredPairingKey(tv) {
  if (!tv?.ip) return;
  delete keys[tv.ip];
  if (tv.mac) delete keys[tv.mac];
  try {
    const filePath = getTempKeyFilePath(tv.mac || tv.ip);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.warn(`[PAIRING] Could not delete the temporary key for ${tv.name || tv.ip}: ${error.message}`);
  }
  try {
    const validKeys = {};
    Object.entries(keys).forEach(([ip, keyValue]) => {
      if (typeof keyValue === 'string' && /^[a-f0-9]{16,}$/i.test(keyValue) && keyValue !== '{}') validKeys[ip] = keyValue;
    });
    fs.writeFileSync(keysFilePath, JSON.stringify(validKeys, null, 2), 'utf8');
  } catch (error) {
    console.warn(`[PAIRING] Could not clear the key persistence for ${tv.name || tv.ip}: ${error.message}`);
  }
}
function shouldRetryPairingWithFreshKey(err) {
  const text = String(err?.message || err?.code || err || '').toLowerCase();
  return /(pair|unauthorized|auth|invalid.*key|client-key|not paired|not authorized|pairing|rejected|forbidden)/i.test(text);
}
function connectTV(tv) {
  if (clients[tv.ip]) closeClient(tv.ip);
  ensureTempKeysDir();
  const tempKeyFile = getTempKeyFilePath(tv.mac || tv.ip);
  try { if (!fs.existsSync(tempKeyFile)) fs.writeFileSync(tempKeyFile, '{}', 'utf8'); } catch (e) {}

  const options = {
    url: `wss://${tv.ip}:3001`,
    keyFile: tempKeyFile,
    verifyCert: false,
    wsconfig: {
      keepalive: true,
      keepaliveInterval: 10000,
      dropConnectionOnKeepaliveTimeout: true,
      keepaliveGracePeriod: 5000,
    },
    saveKey: (newKey, callback) => {
      if (!newKey) {
        if (typeof callback === 'function') callback(null);
        return;
      }
      const finalKey = String(newKey).trim();
      if (finalKey && finalKey !== '{}') {
        keys[tv.ip] = finalKey;
        try { fs.writeFileSync(tempKeyFile, finalKey, 'utf8'); } catch (error) {}
      }
      if (typeof callback === 'function') callback(null);
    },
  };
  if (keys[tv.ip]) options.clientKey = keys[tv.ip];

  console.log(`[CONNECTING] ${tv.name} (${tv.ip})`);
  const client = WebOS(options);
  clients[tv.ip] = client;
  status[tv.ip] = status[tv.ip] || { name: tv.name, group: tv.group, online: false };
  status[tv.ip].name = tv.name;
  status[tv.ip].group = tv.group;

  client.on('connect', () => {
    console.log(`[OK] ${tv.name} connected`);
    status[tv.ip].online = true;
    captureAndSaveKey(tv, client);
  });
  client.on('prompt', () => {
    console.log(`[PAIRING] Please confirm on the TV: ${tv.name}`);
    setTimeout(() => captureAndSaveKey(tv, client), 500);
  });
  client.on('error', err => {
    const reason = err?.code || err?.message || 'error';
    console.warn(`[ERROR] ${tv.name} (${tv.ip}) | ${reason}`);
    status[tv.ip].online = false;
    removeRemoteSocket(tv.ip);

    if (shouldRetryPairingWithFreshKey(err)) {
      if (!pairingRecoveryInProgress[tv.ip]) {
        pairingRecoveryInProgress[tv.ip] = true;
        console.warn(`[PAIRING] A stale key was detected for ${tv.name} (${tv.ip}). Starting a fresh pairing flow.`);
        clearStoredPairingKey(tv);
        closeClient(tv.ip);
        setTimeout(() => {
          delete pairingRecoveryInProgress[tv.ip];
          connectTV(tv);
        }, 1500);
      }
      return;
    }

    if (shouldReconnectFromError(err)) scheduleReconnect(tv, reason);
  });
  client.on('close', () => {
    console.warn(`[DISCONNECTED] ${tv.name} (${tv.ip}) | connection closed`);
    status[tv.ip].online = false;
    removeRemoteSocket(tv.ip);
    scheduleReconnect(tv, 'close');
  });
}
function sendVolumeDown(tv, source = 'SCRIPT') {
  const client = clients[tv.ip];
  console.log(`[SCRIPT] ${source} | ${tv.name} (${tv.ip})`);
  safeRequest(client, 'ssap://audio/volumeDown', undefined, err => {
    if (err) console.warn(`[SCRIPT] ${source} | ${tv.name} (${tv.ip}) | ERROR volumeDown: ${err.message}`);
  });
  getRemoteSocket(tv, (err, sock) => {
    if (err || !sock) {
      console.warn(`[WAKE] ${source} | ${tv.name} (${tv.ip}) | ERROR socket: ${err ? err.message : 'empty socket'}`);
      return;
    }
    try {
      sock.send('move', { dx: 1, dy: 0, down: 0 });
      setTimeout(() => {
        try {
          sock.send('button', { name: 'VOLUMEDOWN' });
        } catch (e) {
          console.warn(`[WAKE] ${source} | ${tv.name} (${tv.ip}) | ERROR VOLUMEDOWN: ${e.message}`);
          removeRemoteSocket(tv.ip);
        }
      }, 150);
    } catch (e) {
      console.warn(`[WAKE] ${source} | ${tv.name} (${tv.ip}) | ERROR MOVE: ${e.message}`);
      removeRemoteSocket(tv.ip);
    }
  });
}
function sendConsoleCommand(tv, command, payload) {
  return new Promise(resolve => {
    const client = clients[tv.ip];
    if (!client) return resolve({ ip: tv.ip, name: tv.name, status: 'error', message: 'Client not initialized' });
    if (!status[tv.ip]?.online) return resolve({ ip: tv.ip, name: tv.name, status: 'error', message: 'TV offline' });
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve({ ip: tv.ip, name: tv.name, status: 'timeout', message: 'No response within 8 seconds' }); }
    }, 8000);
    const callback = (err, response) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) return resolve({ ip: tv.ip, name: tv.name, status: 'error', message: err.message || String(err) });
      resolve({ ip: tv.ip, name: tv.name, status: 'ok', response: response || null });
    };
    safeRequest(client, command, payload ?? undefined, callback);
  });
}

function syncStatusFromManager() {
  const list = store.listDevices();
  list.forEach((device) => {
    const key = device.mac || device.ip || device.id;
    const current = manager.getStatus(key);
    status[device.ip] = {
      name: device.name,
      ip: device.ip,
      group: device.group || 'default',
      online: !!current.online,
      keySaved: !!(device.mac && store.getKey(device.mac)),
      lastSeenAt: current.lastSeenAt || device.lastSeenAt || Date.now(),
    };
  });
}

function initializeRuntime() {
  migrateLegacyTempKeys();
  loadKeys();
  loadKeyResetStats();
  tvs.forEach(connectTV);
  manager.startConnectionHeartbeat();
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString(), devices: store.listDevices().length, keepAlive: manager.keepAliveActive });
});

app.get('/api/devices', (req, res) => {
  const devices = store.listDevices().map(publicDevice);
  res.json(devices);
});

app.post('/api/devices', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.ip && !body.mac) {
      return res.status(400).json({ status: 'error', message: 'Missing IP or MAC' });
    }

    const saved = store.registerOrUpdate({
      id: body.id || body.mac || body.ip,
      name: body.name || 'LG-TV',
      ip: body.ip || '',
      mac: body.mac || null,
      group: body.group || 'default',
      notes: body.notes || '',
      autoDiscovered: !!body.autoDiscovered,
    });

    try {
      await manager.ensureConnected(saved);
    } catch (error) {
      console.warn('[PAIRING] Could not establish connection for saved device:', error.message || error);
    }

    res.json({ status: 'ok', connected: !!manager.getStatus(saved.mac || saved.ip || saved.id).online, message: 'Connection attempt started. Accept the pairing prompt on the TV if it appears.', device: publicDevice(saved) });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.put('/api/devices/:id', (req, res) => {
  try {
    const current = manager.getDeviceById(req.params.id) || store.getDeviceById(req.params.id);
    if (!current) return res.status(404).json({ status: 'error', message: 'Device not found' });

    const next = store.registerOrUpdate({
      ...current,
      ...req.body,
      id: current.id,
      mac: req.body.mac || current.mac || null,
      ip: req.body.ip || current.ip || '',
      name: req.body.name || current.name || 'LG-TV',
      group: req.body.group || current.group || 'default',
      notes: req.body.notes || current.notes || '',
    });

    res.json({ status: 'ok', device: publicDevice(next) });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.delete('/api/devices/:id', (req, res) => {
  try {
    const removed = store.removeDeviceById(req.params.id);
    if (!removed) return res.status(404).json({ status: 'error', message: 'Device not found' });

    const key = removed.mac || removed.ip || removed.id;
    if (manager.clients.has(key)) {
      const tv = manager.clients.get(key);
      tv?.disconnect?.();
      manager.clients.delete(key);
    }
    manager.statuses.delete(key);
    res.json({ status: 'ok', removed: publicDevice(removed) });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/discover', async (req, res) => {
  try {
    const request = req.body && Object.keys(req.body).length ? req.body : { cidr: '10.137.73.0/24' };
    const discovered = await manager.discoverAndConnect(request);
    const devices = store.filterDiscoveredDevices(discovered);
    res.json({ status: 'ok', count: devices.length, range: request, devices: devices.map(publicDevice) });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/discover/range', async (req, res) => {
  try {
    const payload = req.body || {};
    const discovered = await manager.discoverAndConnect(payload);
    const devices = store.filterDiscoveredDevices(discovered);
    res.json({ status: 'ok', count: devices.length, range: { cidr: payload.cidr || null, startIp: payload.startIp || null, endIp: payload.endIp || null }, devices: devices.map(publicDevice) });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/devices/:id/connect', async (req, res) => {
  try {
    const device = manager.getDeviceById(req.params.id) || store.getDeviceById(req.params.id);
    if (!device) return res.status(404).json({ status: 'error', message: 'Device not found' });

    const client = await manager.ensureConnected(device);
    const connected = !!(client && (client.connection === true || client.connection?.connected === true));
    res.json({ status: 'ok', connected, device: publicDevice(device) });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/devices/:id/command', async (req, res) => {
  try {
    const device = manager.getDeviceById(req.params.id) || store.getDeviceById(req.params.id);
    if (!device) return res.status(404).json({ status: 'error', message: 'Device not found' });

    const command = req.body?.command;
    if (!command || typeof command !== 'string') return res.status(400).json({ status: 'error', message: 'Missing command' });

    const result = await manager.executeCommand(device, command, req.body?.payload);
    res.json(result);
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/devices/:id/launch', async (req, res) => {
  try {
    const device = manager.getDeviceById(req.params.id) || store.getDeviceById(req.params.id);
    if (!device) return res.status(404).json({ status: 'error', message: 'Device not found' });

    const targetUrl = req.body?.url || req.body?.target || DASHBOARD_URL;
    const result = await manager.launchUrl(device, targetUrl);
    res.json(result);
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/launch', async (req, res) => {
  try {
    const targetUrl = req.body?.url || req.body?.target || DASHBOARD_URL;
    const devices = Array.isArray(req.body?.targets) && req.body.targets.length
      ? req.body.targets.map((id) => manager.getDeviceById(id) || store.getDeviceById(id)).filter(Boolean)
      : store.listDevices();

    if (!devices.length) return res.status(400).json({ status: 'error', message: 'There are no devices to launch the URL on' });

    const results = await Promise.all(devices.map((device) => manager.launchUrl(device, targetUrl)));
    res.json({ status: 'ok', url: targetUrl, results });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/volume/start', (req, res) => {
  res.json(manager.startKeepAlive());
});

app.post('/api/recheck', async (req, res) => {
  try {
    const devices = store.listDevices();
    const results = await Promise.all(devices.map(async (device) => {
      try {
        const client = await manager.ensureConnected(device);
        const online = !!(client && (client.connection === true || client.connection?.connected === true));
        return { id: device.id, name: device.name, ip: device.ip, online };
      } catch (error) {
        return { id: device.id, name: device.name, ip: device.ip, online: false, error: error?.message || String(error) };
      }
    }));

    syncStatusFromManager();
    res.json({
      status: 'ok',
      total: devices.length,
      online: results.filter((entry) => entry.online).length,
      results,
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/volume/stop', (req, res) => {
  res.json(manager.stopKeepAlive());
});

app.get('/api/devices/:id/keepalive', (req, res) => {
  const device = manager.getDeviceById(req.params.id) || store.getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ status: 'error', message: 'Device not found' });
  res.json(manager.getDeviceKeepAliveState(device));
});

app.post('/api/devices/:id/keepalive', async (req, res) => {
  const device = manager.getDeviceById(req.params.id) || store.getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ status: 'error', message: 'Device not found' });

  const enabled = req.body?.active ?? req.body?.enabled ?? true;
  if (enabled === false) {
    return res.json(manager.stopDeviceKeepAlive(device));
  }

  const result = await manager.startDeviceKeepAlive(device);
  res.json(result);
});

app.get('/api/volume/status', (req, res) => {
  const remainingMs = manager.keepAliveActive && manager.keepAliveNextRunAt
    ? Math.max(0, manager.keepAliveNextRunAt - Date.now())
    : 0;
  res.json({ active: !!manager.keepAliveActive, intervalMs: manager.keepAliveIntervalMs, remainingMs });
});

app.post('/api/volume/down', async (req, res) => {
  try {
    const payload = req.body || {};
    const scope = payload.scope || 'all';
    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    const result = await manager.triggerVolumeDown(scope, targets);
    res.json(result);
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/status', (req, res) => res.json(status));
app.get('/api/keys/status', (req, res) => {
  const result = {};
  const deviceIps = new Set();

  tvs.forEach((tv) => {
    deviceIps.add(tv.ip);
    const keyValue = keys[tv.ip];
    result[tv.ip] = {
      ip: tv.ip,
      name: tv.name,
      hasKey: !!keyValue,
      keyValue: keyValue || 'N/A',
      keyPreview: keyValue || 'N/A',
      connected: !!status[tv.ip]?.online,
      remoteSocket: !!remoteSockets[tv.ip],
      status: keyValue ? 'saved' : 'missing',
      resetCount: getKeyResetCount(tv.ip, keyValue),
    };
  });

  Object.keys(keys).forEach((ip) => {
    if (deviceIps.has(ip)) return;
    const keyValue = keys[ip];
    result[ip] = {
      ip,
      name: getDeviceNameForIp(ip),
      hasKey: !!keyValue,
      keyValue: keyValue || 'N/A',
      keyPreview: keyValue || 'N/A',
      connected: !!status[ip]?.online,
      remoteSocket: !!remoteSockets[ip],
      status: keyValue ? 'saved' : 'missing',
      resetCount: getKeyResetCount(ip, keyValue),
    };
  });

  res.json(result);
});
app.get('/api/keys/list', (req, res) => {
  const safe = {};
  Object.entries(keys).forEach(([ip, key]) => safe[ip] = key ? key.substring(0, 8) + '...' : 'invalid');
  res.json(safe);
});
app.get('/api/keys/debug', (req, res) => res.json({ keysCount: Object.keys(keys).length, keysFile: keysFilePath, fileExists: fs.existsSync(keysFilePath), tvs: tvs.map(tv => ({ name: tv.name, ip: tv.ip, hasKey: !!keys[tv.ip], connected: !!status[tv.ip]?.online })) }));
app.post('/api/keys/reset', (req, res) => {
  const resetEntries = Object.entries(keys).map(([ip, keyValue]) => ({ ip, keyValue }));
  keys = {};
  try { fs.writeFileSync(keysFilePath, '{}', 'utf8'); } catch (e) {}
  Object.keys(remoteSockets).forEach(removeRemoteSocket);
  resetEntries.forEach(({ ip, keyValue }) => registerKeyReset(ip, keyValue));
  tvs.forEach(tv => { closeClient(tv.ip); scheduleReconnect(tv, 'keys reset'); });
  res.json({ status: 'success', message: 'Keys reset; reconnecting...' });
});

app.post('/api/web-dashboard/pointer', async (req, res) => {
  try {
    const { targets, action, dx, dy, packetSize } = req.body || {};
    const selected = selectedTvs(targets);
    if (!selected.length) return res.status(400).json({ status: 'error', message: 'Select at least one TV' });
    const results = await Promise.all(selected.map(tv => pointerAction(tv, action, { dx, dy, packetSize })));
    res.json({ status: 'ok', results });
  } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});
app.post('/api/web-dashboard/launch', async (req, res) => {
  try {
    const selected = selectedTvs(req.body?.targets);
    if (!selected.length) return res.status(400).json({ status: 'error', message: 'Select at least one TV' });
    const results = await Promise.all(selected.map(tv => pointerAction(tv, 'open', { url: DASHBOARD_URL })));
    res.json({ status: 'ok', results });
  } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});
app.post('/api/console/command', async (req, res) => {
  try {
    const { targets, command, payload } = req.body || {};
    const selected = selectedTvs(targets);
    if (!selected.length) return res.status(400).json({ status: 'error', message: 'Select at least one TV' });
    if (typeof command !== 'string' || !command.trim().startsWith('ssap://')) return res.status(400).json({ status: 'error', message: 'Invalid command' });
    const results = await Promise.all(selected.map(tv => sendConsoleCommand(tv, command.trim(), payload)));
    res.json({ status: 'ok', results });
  } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let server = null;

if (require.main === module) {
  initializeRuntime();
  server = app.listen(PORT, () => {
    console.log(`Panel: http://localhost:${PORT}`);
    const savedDevices = store.listDevices();
    if (savedDevices.length) {
      savedDevices.filter(device => device.ip).forEach((device) => {
        manager.ensureConnected(device).catch((error) => {
          console.warn(`[BOOT] Could not restore ${device.name} (${device.ip}): ${error?.message || String(error)}`);
        });
      });
    }
  });
}

process.on('SIGINT', () => {
  for (const tv of manager.clients.values()) {
    try { tv.disconnect?.(); } catch (error) {}
  }
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
});

process.on('SIGTERM', () => {
  for (const tv of manager.clients.values()) {
    try { tv.disconnect?.(); } catch (error) {}
  }
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
});

module.exports = {
  app,
  clients,
  status,
  getRemoteSocket,
  getRemoteSocketAsync,
  removeRemoteSocket,
  pointerAction,
  selectedTvs,
};
