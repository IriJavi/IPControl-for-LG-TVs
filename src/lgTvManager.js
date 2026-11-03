process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');
const path = require('path');
const LGTV = require('lgtv2');
const { discoverLGTVs } = require('./network');

class LGTVManager {
  constructor({ store, rootDir, logger = console }) {
    this.store = store;
    this.rootDir = rootDir || process.cwd();
    this.logger = logger;
    this.clients = new Map();
    this.statuses = new Map();
    this.keepAliveTimer = null;
    this.keepAliveActive = false;
    this.keepAliveIntervalMs = 60 * 1000;
  }

  keyForDevice(device) {
    return String(device?.mac || device?.ip || device?.id || 'unknown');
  }

  getKeyFilePath(device) {
    const safeIp = String(device?.ip || device?.id || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(this.rootDir, `.lgtv-keys-temp-${safeIp}`);
  }

  getKeyCandidates(device) {
    const values = new Set();
    if (device?.mac) values.add(device.mac);
    if (device?.ip) values.add(device.ip);
    if (device?.id) values.add(device.id);
    const normalizedMac = device?.mac ? device.mac.toLowerCase().replace(/[^a-f0-9]/g, '') : null;
    if (normalizedMac) {
      const withColons = normalizedMac.match(/.{1,2}/g)?.join(':') || normalizedMac;
      values.add(withColons);
      values.add(normalizedMac);
    }
    return [...values].filter(Boolean);
  }

  resolveSavedKey(device) {
    for (const candidate of this.getKeyCandidates(device)) {
      const savedKey = this.store.getKey(candidate);
      if (savedKey) return savedKey;
    }

    const keyFile = this.getKeyFilePath(device);
    try {
      const raw = fs.readFileSync(keyFile, 'utf8').trim();
      if (raw && raw !== '{}' && raw.length > 10) return raw;
    } catch (error) {
      // ignore missing temp key files when reconnecting; the key will be restored from the store
    }

    return null;
  }

  persistKey(device, newKey, keyFile = this.getKeyFilePath(device)) {
    const keyValue = typeof newKey === 'string' ? newKey.trim() : '';
    if (!keyValue || keyValue === '{}' || keyValue.length < 10) return null;

    for (const candidate of this.getKeyCandidates(device)) {
      this.store.setKey(candidate, keyValue);
    }

    try {
      fs.writeFileSync(keyFile, keyValue, 'utf8');
    } catch (error) {
      this.logger.warn(`[KEYFILE] No se pudo persistir la clave para ${device?.ip || device?.id || 'TV'}: ${error.message || String(error)}`);
    }

    return keyValue;
  }

  getDeviceById(id) {
    return this.store.getDeviceById(id) || this.store.getDeviceByMac(id) || this.store.getDeviceByIp(id);
  }

  getStatus(key) {
    return this.statuses.get(key) || { online: false, lastSeenAt: Date.now() };
  }

  setStatus(device, extra = {}) {
    const key = this.keyForDevice(device);
    const next = {
      id: device.id,
      ip: device.ip,
      mac: device.mac || null,
      name: device.name,
      group: device.group || 'default',
      online: false,
      keySaved: !!(device.mac && this.store.getKey(device.mac)),
      lastSeenAt: Date.now(),
      ...this.getStatus(key),
      ...extra,
    };

    this.statuses.set(key, next);
    return next;
  }

  async connectDevice(device) {
    const dbDevice = this.store.normalizeDevice(device);
    if (!dbDevice.ip) {
      throw new Error('No hay IP para conectar la TV');
    }

    const key = this.keyForDevice(dbDevice);
    const existing = this.clients.get(key);
    if (existing) return existing;

    const savedKey = this.resolveSavedKey(dbDevice);
    const keyFile = this.getKeyFilePath(dbDevice);

    if (savedKey) {
      this.persistKey(dbDevice, savedKey, keyFile);
    } else {
      try {
        const fileKey = fs.readFileSync(keyFile, 'utf8').trim();
        if (fileKey && fileKey !== '{}' && fileKey.length > 10) {
          this.persistKey(dbDevice, fileKey, keyFile);
        }
      } catch (error) {
        // ignore missing key files when there is no stored key yet
      }
    }

    const tv = new LGTV({
      url: `wss://${dbDevice.ip}:3001`,
      keyFile,
      clientKey: savedKey || undefined,
      rejectUnauthorized: false,
      reconnect: 5000,
      keepalive: true,
      timeout: 15000,
      saveKey: (newKey) => {
        if (!newKey) return null;
        const finalKey = String(newKey).trim();
        if (dbDevice.mac) this.store.setKey(dbDevice.mac, finalKey);
        if (dbDevice.ip) this.store.setKey(dbDevice.ip, finalKey);
        try { fs.writeFileSync(keyFile, finalKey, 'utf8'); } catch (error) {}
        return finalKey;
      },
    });

    this.clients.set(key, tv);
    this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });

    tv.on('connect', () => {
      const current = this.store.normalizeDevice(dbDevice);
      const saved = tv.clientKey || this.resolveSavedKey(current);
      if (saved) {
        this.persistKey(current, saved, keyFile);
      }

      this.setStatus(current, {
        online: true,
        keySaved: !!(current.mac ? this.store.getKey(current.mac) : this.store.getKey(current.ip)),
        lastSeenAt: Date.now(),
      });
      this.logger.log(`[OK] ${current.name} conectada en ${current.ip}`);
    });

    tv.on('prompt', () => {
      this.logger.warn(`[PROMPT] ${dbDevice.name} en ${dbDevice.ip}: acepta la petición en la TV`);
      this.setStatus(dbDevice, { online: false, promptRequired: true, lastSeenAt: Date.now() });
      const keyValue = tv.clientKey || this.resolveSavedKey(dbDevice);
      if (keyValue) {
        this.persistKey(dbDevice, keyValue, keyFile);
      }
    });

    tv.on('error', (error) => {
      this.logger.warn(`[ERROR] ${dbDevice.name} (${dbDevice.ip}): ${error?.message || String(error)}`);
      this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });
    });

    tv.on('close', () => {
      this.logger.warn(`[CLOSE] ${dbDevice.name} (${dbDevice.ip}) cerrada`);
      this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });
    });

    tv.on('key', (clientKey) => {
      if (clientKey) {
        this.persistKey(dbDevice, clientKey, keyFile);
      }
    });

    return tv;
  }

  async ensureConnected(device) {
    const dbDevice = this.store.normalizeDevice(device);
    let client = this.clients.get(this.keyForDevice(dbDevice));
    if (!client) {
      client = await this.connectDevice(dbDevice);
    }

    const isConnected = !!(client && (client.connection === true || client.connection?.connected === true));
    if (!isConnected && client && typeof client.connect === 'function') {
      try {
        client.connect(`wss://${dbDevice.ip}:3001`);
      } catch (error) {
        this.logger.warn(`[RETRY] No se pudo reconnectar ${dbDevice.ip}: ${error?.message || String(error)}`);
      }
    }
    return client;
  }

  async executeCommand(device, command, payload) {
    const dbDevice = this.store.normalizeDevice(device);
    if (!dbDevice.ip) {
      return { status: 'error', message: 'No hay IP para este dispositivo' };
    }

    const client = await this.ensureConnected(dbDevice);
    const connectedNow = !!(client && (client.connection === true || client.connection?.connected === true));

    if (!client || !connectedNow) {
      this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });
      return { status: 'error', name: dbDevice.name, ip: dbDevice.ip, message: 'La TV no está conectada' };
    }

    try {
      const response = await client.request(command, payload);
      this.setStatus(dbDevice, {
        online: true,
        keySaved: !!(dbDevice.mac ? this.store.getKey(dbDevice.mac) : this.store.getKey(dbDevice.ip)),
        lastSeenAt: Date.now(),
      });
      return { status: 'ok', name: dbDevice.name, ip: dbDevice.ip, response };
    } catch (error) {
      this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });
      return { status: 'error', name: dbDevice.name, ip: dbDevice.ip, message: error?.message || String(error) };
    }
  }

  async launchUrl(device, url) {
    const dbDevice = this.store.normalizeDevice(device);
    const targetUrl = url || 'https://6b10-mes.mobis.com/dashboard.do';

    if (!dbDevice.ip) {
      return { status: 'error', message: 'No hay IP para este dispositivo' };
    }

    const client = await this.ensureConnected(dbDevice);
    const connectedNow = !!(client && (client.connection === true || client.connection?.connected === true));

    if (!client || !connectedNow) {
      this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });
      return { status: 'error', name: dbDevice.name, ip: dbDevice.ip, message: 'La TV no está conectada' };
    }

    try {
      const response = await client.request('ssap://system.launcher/open', { target: targetUrl });
      this.setStatus(dbDevice, {
        online: true,
        keySaved: !!(dbDevice.mac ? this.store.getKey(dbDevice.mac) : this.store.getKey(dbDevice.ip)),
        lastSeenAt: Date.now(),
      });
      return { status: 'ok', name: dbDevice.name, ip: dbDevice.ip, url: targetUrl, response };
    } catch (error) {
      this.setStatus(dbDevice, { online: false, lastSeenAt: Date.now() });
      return { status: 'error', name: dbDevice.name, ip: dbDevice.ip, message: error?.message || String(error), url: targetUrl };
    }
  }

  async discoverAndConnect(options = {}) {
    const discovered = await discoverLGTVs(options);

    return discovered.map((item) => {
      const normalized = this.store.normalizeDevice(item);
      const key = this.keyForDevice(normalized);
      const current = this.getStatus(key);
      this.statuses.set(key, {
        ...current,
        id: normalized.id,
        ip: normalized.ip,
        mac: normalized.mac,
        name: normalized.name,
        group: normalized.group || 'default',
        online: false,
        lastSeenAt: Date.now(),
      });
      return normalized;
    });
  }

  startKeepAlive() {
    if (this.keepAliveActive) return { status: 'ok', active: true };

    this.keepAliveActive = true;
    const tick = async () => {
      const devices = this.store.listDevices();
      for (const device of devices) {
        try {
          if (device.ip) {
            await this.executeCommand(device, 'ssap://audio/volumeDown');
          }
        } catch (error) {
          this.logger.warn(`[KEEPALIVE] ${device.name}: ${error.message || String(error)}`);
        }
      }
    };

    tick();
    this.keepAliveTimer = setInterval(() => {
      tick().catch(() => {});
    }, this.keepAliveIntervalMs);

    return { status: 'ok', active: true };
  }

  stopKeepAlive() {
    this.keepAliveActive = false;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    return { status: 'ok', active: false };
  }

  async triggerVolumeDown(scope = 'all', targets = []) {
    const devices = [];
    const catalog = this.store.listDevices();

    if (scope === 'all') {
      catalog.forEach((device) => devices.push(device));
    } else if (scope === 'group') {
      const groupName = Array.isArray(targets) ? targets[0] : targets;
      catalog.forEach((device) => {
        if (device.group === groupName) devices.push(device);
      });
    } else if (Array.isArray(targets) && targets.length) {
      targets.forEach((id) => {
        const device = this.getDeviceById(id);
        if (device) devices.push(device);
      });
    }

    const unique = [];
    const seen = new Set();
    for (const device of devices) {
      const key = device.mac || device.ip || device.id;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(device);
      }
    }

    const results = [];
    for (const device of unique) {
      results.push(await this.executeCommand(device, 'ssap://audio/volumeDown'));
    }

    return { status: 'ok', results };
  }
}

module.exports = { LGTVManager };
