process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const path = require('path');
const express = require('express');
const WebOS = require('lgtv2');
const { DeviceStore } = require('./src/deviceStore');
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
const VOLUME_INTERVAL_MS = 300000;
const rootDir = __dirname;
const keysFilePath = path.join(__dirname, 'keys.json');
const store = new DeviceStore(rootDir);
const manager = new LGTVManager({ store, rootDir, logger: console });

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
const clients = {};
const status = {};
const reconnectTimers = {};
const remoteSockets = {};
const remoteSocketOpening = {};
let volumeDownActive = false;
let volumeDownInterval = null;
let volumeDownNextRunAt = null;
const groupVolumeIntervals = {};
const groupVolumeNextRunAt = {};

function publicDevice(device) {
  const key = device.mac || device.ip || device.id;
  const statusEntry = manager.getStatus(key);
  const keySaved = !!(device.mac && store.getKey(device.mac));

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
  };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeRequest(client, uri, payload, callback) {
  try {
    if (!client) return callback && callback(new Error('Cliente no disponible'));
    if (payload !== undefined) return client.request(uri, payload, callback || (() => {}));
    return client.request(uri, callback || (() => {}));
  } catch (error) {
    if (callback) callback(error);
    return null;
  }
}
function loadKeys() {
  try {
    const parsed = fs.existsSync(keysFilePath) ? JSON.parse(fs.readFileSync(keysFilePath, 'utf8')) : {};
    keys = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('[KEYS] Error cargando keys.json:', error.message);
    keys = {};
  }

  try {
    const files = fs.readdirSync(__dirname).filter(file => file.startsWith('.lgtv-keys-temp-'));
    files.forEach(file => {
      const ip = file.replace(/^\.lgtv-keys-temp-/, '');
      if (!ip) return;
      try {
        const raw = fs.readFileSync(path.join(__dirname, file), 'utf8').trim();
        if (raw && raw !== '{}' && raw.length > 10) keys[ip] = raw;
      } catch (error) {
        // ignore read errors on temp files
      }
    });
  } catch (error) {
    console.warn('[KEYS] No se pudieron cargar las claves temporales legacy:', error.message);
  }

  const validKeys = {};
  Object.entries(keys).forEach(([ip, key]) => {
    if (typeof key === 'string' && key.length > 10 && key !== '{}') validKeys[ip] = key;
  });
  keys = validKeys;
  console.log(`[KEYS] ${Object.keys(keys).length} claves cargadas`);
}
function saveLegacyKeyFile(ip, keyValue) {
  if (!ip || !keyValue) return;
  const tempKeyFile = path.join(__dirname, `.lgtv-keys-temp-${ip}`);
  try {
    fs.writeFileSync(tempKeyFile, String(keyValue).trim(), 'utf8');
  } catch (error) {
    console.warn(`[KEYS] No se pudo guardar la temp key ${ip}: ${error.message}`);
  }
}
function saveKeys() {
  const validKeys = {};
  Object.entries(keys).forEach(([ip, key]) => {
    if (typeof key === 'string' && key.length > 10 && key !== '{}') validKeys[ip] = key;
  });
  try {
    if (fs.existsSync(keysFilePath)) fs.copyFileSync(keysFilePath, keysFilePath + '.bak');
    fs.writeFileSync(keysFilePath, JSON.stringify(validKeys, null, 2), 'utf8');
    keys = validKeys;
    Object.entries(keys).forEach(([ip, keyValue]) => saveLegacyKeyFile(ip, keyValue));
    console.log(`[KEYS] Guardadas ${Object.keys(keys).length} claves válidas`);
  } catch (error) {
    console.error('[KEYS] Error guardando keys.json:', error.message);
  }
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
  if (!client) return callback(new Error(`No hay cliente para ${tv.name}`));
  if (remoteSockets[tv.ip]) return callback(null, remoteSockets[tv.ip]);
  if (remoteSocketOpening[tv.ip]) return callback(new Error(`Socket remoto abriéndose para ${tv.name}`));
  if (typeof client.getSocket !== 'function') return callback(new Error(`getSocket no disponible para ${tv.name}`));

  remoteSocketOpening[tv.ip] = true;
  try {
    client.getSocket('ssap://com.webos.service.networkinput/getPointerInputSocket', (err, sock) => {
      remoteSocketOpening[tv.ip] = false;
      if (err || !sock) {
        delete remoteSockets[tv.ip];
        return callback(err || new Error(`Socket remoto vacío para ${tv.name}`));
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
  if (!client) return { ip: tv.ip, name: tv.name, status: 'error', message: 'Cliente no inicializado' };
  if (!status[tv.ip]?.online) return { ip: tv.ip, name: tv.name, status: 'error', message: 'TV offline' };

  if (action === 'open') {
    return new Promise(resolve => {
      safeRequest(client, 'ssap://system.launcher/open', { target: options.url || DASHBOARD_URL }, err => {
        resolve(err ? { ip: tv.ip, name: tv.name, status: 'error', message: err.message } : { ip: tv.ip, name: tv.name, status: 'ok', action: 'open' });
      });
    });
  }

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
    return { ip: tv.ip, name: tv.name, status: 'error', message: 'Acción no soportada' };
  } catch (error) {
    removeRemoteSocket(tv.ip);
    return { ip: tv.ip, name: tv.name, status: 'error', message: error.message };
  }
}
function captureAndSaveKey(tv, client) {
  const keyValue = typeof client.clientKey === 'string' ? client.clientKey : client.clientKey?.toString?.();
  if (keyValue && keyValue.length > 10 && keyValue !== '{}' && keys[tv.ip] !== keyValue) {
    keys[tv.ip] = keyValue;
    saveLegacyKeyFile(tv.ip, keyValue);
    saveKeys();
    console.log(`[KEYS] Key guardada para ${tv.name}`);
  }
}
function scheduleReconnect(tv, reason = 'close') {
  if (reconnectTimers[tv.ip]) {
    console.log(`[RECONNECT] ${tv.name} (${tv.ip}) | ya programado | motivo: ${reason}`);
    return;
  }
  console.warn(`[RECONNECT] ${tv.name} (${tv.ip}) | reintento en 5s | motivo: ${reason}`);
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
function connectTV(tv) {
  if (clients[tv.ip]) closeClient(tv.ip);
  const tempKeyFile = path.join(__dirname, `.lgtv-keys-temp-${tv.ip}`);
  try { if (!fs.existsSync(tempKeyFile)) fs.writeFileSync(tempKeyFile, '{}', 'utf8'); } catch (e) {}

  const options = { url: `wss://${tv.ip}:3001`, keyFile: tempKeyFile };
  if (keys[tv.ip]) options.clientKey = keys[tv.ip];

  console.log(`[CONECTANDO] ${tv.name} (${tv.ip})`);
  const client = WebOS(options);
  clients[tv.ip] = client;
  status[tv.ip] = status[tv.ip] || { name: tv.name, group: tv.group, online: false };
  status[tv.ip].name = tv.name;
  status[tv.ip].group = tv.group;

  client.on('connect', () => {
    console.log(`[OK] ${tv.name} conectado`);
    status[tv.ip].online = true;
    captureAndSaveKey(tv, client);
  });
  client.on('prompt', () => {
    console.log(`[PAIRING] Confirma en la TV: ${tv.name}`);
    setTimeout(() => captureAndSaveKey(tv, client), 500);
  });
  client.on('error', err => {
    const reason = err?.code || err?.message || 'error';
    console.warn(`[ERROR] ${tv.name} (${tv.ip}) | ${reason}`);
    status[tv.ip].online = false;
    removeRemoteSocket(tv.ip);
    if (shouldReconnectFromError(err)) scheduleReconnect(tv, reason);
  });
  client.on('close', () => {
    console.warn(`[DESCONECTADO] ${tv.name} (${tv.ip}) | conexión cerrada`);
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
      console.warn(`[WAKE] ${source} | ${tv.name} (${tv.ip}) | ERROR socket: ${err ? err.message : 'socket vacío'}`);
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
function startVolumeDown() {
  if (volumeDownActive) return;
  volumeDownActive = true;
  volumeDownNextRunAt = Date.now() + VOLUME_INTERVAL_MS;
  console.log('[SCRIPT] MASTER activado');
  tvs.forEach(tv => sendVolumeDown(tv, 'MASTER'));
  volumeDownInterval = setInterval(() => {
    volumeDownNextRunAt = Date.now() + VOLUME_INTERVAL_MS;
    console.log('[SCRIPT] MASTER ciclo');
    tvs.forEach(tv => sendVolumeDown(tv, 'MASTER'));
  }, VOLUME_INTERVAL_MS);
}
function stopVolumeDown() {
  if (!volumeDownActive) return;
  clearInterval(volumeDownInterval);
  volumeDownInterval = null;
  volumeDownActive = false;
  volumeDownNextRunAt = null;
  console.log('[SCRIPT] MASTER desactivado');
}
function startGroupVolumeDown(group) {
  if (groupVolumeIntervals[group]) return;
  const groupTvs = tvsByGroup(group);
  groupVolumeNextRunAt[group] = Date.now() + VOLUME_INTERVAL_MS;
  console.log(`[SCRIPT] GROUP ${group} activado`);
  groupTvs.forEach(tv => sendVolumeDown(tv, `GROUP ${group}`));
  groupVolumeIntervals[group] = setInterval(() => {
    groupVolumeNextRunAt[group] = Date.now() + VOLUME_INTERVAL_MS;
    console.log(`[SCRIPT] GROUP ${group} ciclo`);
    groupTvs.forEach(tv => sendVolumeDown(tv, `GROUP ${group}`));
  }, VOLUME_INTERVAL_MS);
}
function stopGroupVolumeDown(group) {
  if (!groupVolumeIntervals[group]) return;
  clearInterval(groupVolumeIntervals[group]);
  delete groupVolumeIntervals[group];
  delete groupVolumeNextRunAt[group];
  console.log(`[SCRIPT] GROUP ${group} desactivado`);
}
function sendPower(group, uri, source = 'POWER') {
  console.log(`[POWER] ${source} | ${uri} | targets:${group.length}`);
  group.forEach(tv => safeRequest(clients[tv.ip], uri));
}
function sendConsoleCommand(tv, command, payload) {
  return new Promise(resolve => {
    const client = clients[tv.ip];
    if (!client) return resolve({ ip: tv.ip, name: tv.name, status: 'error', message: 'Cliente no inicializado' });
    if (!status[tv.ip]?.online) return resolve({ ip: tv.ip, name: tv.name, status: 'error', message: 'TV offline' });
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve({ ip: tv.ip, name: tv.name, status: 'timeout', message: 'Sin respuesta en 8 segundos' }); }
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

loadKeys();
tvs.forEach(connectTV);
setInterval(() => Object.values(clients).forEach(client => safeRequest(client, 'ssap://audio/getVolume')), 60000);

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
    if (!current) return res.status(404).json({ status: 'error', message: 'Dispositivo no encontrado' });

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
    if (!removed) return res.status(404).json({ status: 'error', message: 'Dispositivo no encontrado' });

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
    const devices = await manager.discoverAndConnect(request);
    res.json({ status: 'ok', count: devices.length, range: request, devices: devices.map(publicDevice) });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/discover/range', async (req, res) => {
  try {
    const payload = req.body || {};
    const devices = await manager.discoverAndConnect(payload);
    res.json({ status: 'ok', count: devices.length, range: { cidr: payload.cidr || null, startIp: payload.startIp || null, endIp: payload.endIp || null }, devices: devices.map(publicDevice) });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/devices/:id/connect', async (req, res) => {
  try {
    const device = manager.getDeviceById(req.params.id) || store.getDeviceById(req.params.id);
    if (!device) return res.status(404).json({ status: 'error', message: 'Dispositivo no encontrado' });

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
    if (!device) return res.status(404).json({ status: 'error', message: 'Dispositivo no encontrado' });

    const command = req.body?.command;
    if (!command || typeof command !== 'string') return res.status(400).json({ status: 'error', message: 'Falta command' });

    const result = await manager.executeCommand(device, command, req.body?.payload);
    res.json(result);
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/devices/:id/launch', async (req, res) => {
  try {
    const device = manager.getDeviceById(req.params.id) || store.getDeviceById(req.params.id);
    if (!device) return res.status(404).json({ status: 'error', message: 'Dispositivo no encontrado' });

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

    if (!devices.length) return res.status(400).json({ status: 'error', message: 'No hay dispositivos para lanzar la URL' });

    const results = await Promise.all(devices.map((device) => manager.launchUrl(device, targetUrl)));
    res.json({ status: 'ok', url: targetUrl, results });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/volume/start', (req, res) => {
  res.json(manager.startKeepAlive());
});

app.post('/api/volume/stop', (req, res) => {
  res.json(manager.stopKeepAlive());
});

app.get('/api/volume/status', (req, res) => {
  res.json({ active: !!manager.keepAliveActive, intervalMs: manager.keepAliveIntervalMs });
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
  tvs.forEach(tv => {
    result[tv.name] = { ip: tv.ip, hasKey: !!keys[tv.ip], keyPreview: keys[tv.ip] ? keys[tv.ip].substring(0, 8) + '...' : 'N/A', connected: !!status[tv.ip]?.online, remoteSocket: !!remoteSockets[tv.ip] };
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
  keys = {};
  try { fs.writeFileSync(keysFilePath, '{}', 'utf8'); } catch (e) {}
  Object.keys(remoteSockets).forEach(removeRemoteSocket);
  tvs.forEach(tv => { closeClient(tv.ip); scheduleReconnect(tv, 'keys reset'); });
  res.json({ status: 'success', message: 'Keys reseteadas, reconectando...' });
});

app.post('/api/all/on', (req, res) => { sendPower(tvs, 'ssap://system/turnOn', 'MASTER ON'); res.send('OK'); });
app.post('/api/all/off', (req, res) => { sendPower(tvs, 'ssap://system/turnOff', 'MASTER OFF'); res.send('OK'); });
app.post('/api/group/:group/on', (req, res) => { sendPower(tvsByGroup(req.params.group), 'ssap://system/turnOn', `GROUP ${req.params.group} ON`); res.send('OK'); });
app.post('/api/group/:group/off', (req, res) => { sendPower(tvsByGroup(req.params.group), 'ssap://system/turnOff', `GROUP ${req.params.group} OFF`); res.send('OK'); });
app.get('/api/volume-down/start', (req, res) => { startVolumeDown(); res.json({ status: 'active', nextRunAt: volumeDownNextRunAt, remainingMs: Math.max(0, (volumeDownNextRunAt || 0) - Date.now()), intervalMs: VOLUME_INTERVAL_MS }); });
app.get('/api/volume-down/stop', (req, res) => { stopVolumeDown(); res.json({ status: 'inactive', nextRunAt: null, remainingMs: 0, intervalMs: VOLUME_INTERVAL_MS }); });
app.get('/api/volume-down/status', (req, res) => res.json({ status: volumeDownActive ? 'active' : 'inactive', nextRunAt: volumeDownNextRunAt, remainingMs: volumeDownActive ? Math.max(0, (volumeDownNextRunAt || 0) - Date.now()) : 0, intervalMs: VOLUME_INTERVAL_MS }));
app.post('/api/group/:group/volume-down/start', (req, res) => { startGroupVolumeDown(req.params.group); const nextRunAt = groupVolumeNextRunAt[req.params.group] || null; res.json({ status: 'active', nextRunAt, remainingMs: Math.max(0, (nextRunAt || 0) - Date.now()), intervalMs: VOLUME_INTERVAL_MS }); });
app.post('/api/group/:group/volume-down/stop', (req, res) => { stopGroupVolumeDown(req.params.group); res.json({ status: 'inactive', nextRunAt: null, remainingMs: 0, intervalMs: VOLUME_INTERVAL_MS }); });

app.get('/api/group-volume-down/status', (req, res) => {
  const groups = {};
  Object.keys(groupVolumeIntervals).forEach(group => {
    const nextRunAt = groupVolumeNextRunAt[group] || null;
    groups[group] = {
      status: 'active',
      nextRunAt,
      remainingMs: Math.max(0, (nextRunAt || 0) - Date.now()),
      intervalMs: VOLUME_INTERVAL_MS
    };
  });
  res.json({ groups });
});
app.post('/api/group/:group/wake-screensaver', (req, res) => { tvsByGroup(req.params.group).forEach(tv => getRemoteSocket(tv, () => {})); res.send('OK'); });
app.post('/api/web-dashboard/pointer', async (req, res) => {
  try {
    const { targets, action, dx, dy, packetSize } = req.body || {};
    const selected = selectedTvs(targets);
    if (!selected.length) return res.status(400).json({ status: 'error', message: 'Selecciona al menos una TV' });
    const results = await Promise.all(selected.map(tv => pointerAction(tv, action, { dx, dy, packetSize })));
    res.json({ status: 'ok', results });
  } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});
app.post('/api/web-dashboard/launch', async (req, res) => {
  try {
    const selected = selectedTvs(req.body?.targets);
    if (!selected.length) return res.status(400).json({ status: 'error', message: 'Selecciona al menos una TV' });
    const results = await Promise.all(selected.map(tv => pointerAction(tv, 'open', { url: DASHBOARD_URL })));
    res.json({ status: 'ok', results });
  } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});
app.post('/api/console/command', async (req, res) => {
  try {
    const { targets, command, payload } = req.body || {};
    const selected = selectedTvs(targets);
    if (!selected.length) return res.status(400).json({ status: 'error', message: 'Selecciona al menos una TV' });
    if (typeof command !== 'string' || !command.trim().startsWith('ssap://')) return res.status(400).json({ status: 'error', message: 'Comando inválido' });
    const results = await Promise.all(selected.map(tv => sendConsoleCommand(tv, command.trim(), payload)));
    res.json({ status: 'ok', results });
  } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Panel: http://localhost:${PORT}`);
  const savedDevices = store.listDevices();
  if (savedDevices.length) {
    savedDevices.filter(device => device.ip).forEach((device) => {
      manager.ensureConnected(device).catch((error) => {
        console.warn(`[BOOT] No se pudo restaurar ${device.name} (${device.ip}): ${error?.message || String(error)}`);
      });
    });
  }
});

process.on('SIGINT', () => {
  for (const tv of manager.clients.values()) {
    try { tv.disconnect?.(); } catch (error) {}
  }
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  for (const tv of manager.clients.values()) {
    try { tv.disconnect?.(); } catch (error) {}
  }
  server.close(() => process.exit(0));
});
