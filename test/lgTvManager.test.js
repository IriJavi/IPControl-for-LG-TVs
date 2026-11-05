const test = require('node:test');
const assert = require('node:assert/strict');
const { DeviceStore } = require('../src/deviceStore');
const { LGTVManager } = require('../src/lgTvManager');
const server = require('../server');
const { getRemoteSocket } = server;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('startKeepAlive should simulate a remote volume key press to wake TVs', async () => {
  const store = new DeviceStore(__dirname);
  store.registerOrUpdate({
    id: 'tv-keepalive',
    name: 'Living Room',
    ip: '10.0.0.21',
    mac: 'aa:bb:cc:dd:ee:ff',
    group: 'default',
  });

  const manager = new LGTVManager({ store, rootDir: __dirname, logger: console });
  let socketMoves = [];
  let socketButtons = [];

  manager.executeCommand = async () => ({ status: 'ok' });
  manager.ensureConnected = async () => ({
    connection: { connected: true },
    getSocket: (_service, cb) => {
      const sock = {
        send: (type, payload) => {
          if (type === 'move') socketMoves.push(payload);
          if (type === 'button') socketButtons.push(payload);
        },
      };
      cb(null, sock);
    },
  });

  try {
    const result = manager.startKeepAlive();
    assert.equal(result.status, 'ok');

    await wait(200);
    assert.ok(socketMoves.some((payload) => payload.dx === 1 && payload.dy === 0), 'Debe enviar un movimiento del puntero para activar la toma de control');
    assert.ok(socketButtons.some((payload) => payload.name === 'VOLUMEDOWN'), 'Debe simular el botón VOLUMEDOWN en el mando virtual');
  } finally {
    manager.stopKeepAlive();
  }
});

test('startDeviceKeepAlive should manage a timer only for one TV', async () => {
  const store = new DeviceStore(__dirname);
  store.registerOrUpdate({
    id: 'tv-device-keepalive',
    name: 'Bedroom',
    ip: '10.0.0.22',
    mac: 'ee:ff:aa:bb:cc:dd',
    group: 'default',
  });

  const manager = new LGTVManager({ store, rootDir: __dirname, logger: console });
  let calls = 0;

  manager.executeCommand = async () => ({ status: 'ok' });
  manager.ensureConnected = async () => ({
    connection: { connected: true },
    getSocket: (_service, cb) => {
      const sock = {
        send: (type, payload) => {
          if (type === 'move') calls += 1;
          if (type === 'button') calls += 1;
        },
      };
      cb(null, sock);
    },
  });

  const started = await manager.startDeviceKeepAlive(store.listDevices()[0]);
  assert.equal(started.status, 'ok');
  assert.equal(started.active, true);

  const statusNow = manager.getDeviceKeepAliveState(store.listDevices()[0]);
  assert.equal(statusNow.active, true);
  assert.ok(statusNow.remainingMs > 0);

  const stopped = manager.stopDeviceKeepAlive(store.listDevices()[0]);
  assert.equal(stopped.status, 'ok');
  assert.equal(stopped.active, false);
  assert.equal(manager.getDeviceKeepAliveState(store.listDevices()[0]).active, false);
  assert.ok(calls > 0, 'Debe ejecutar el wake-up al activar el KeepAlive individual');
});

test('getKeyFilePath should prefer the MAC as the canonical temp key name, while allowing IP fallback', () => {
  const store = new DeviceStore(__dirname);
  const manager = new LGTVManager({ store, rootDir: __dirname, logger: console });
  const macKeyPath = manager.getKeyFilePath({ ip: '10.0.0.55', mac: 'aa:bb:cc:dd:ee:ff' });
  const ipFallbackPath = manager.getKeyFilePath({ ip: '10.0.0.66' });

  assert.match(macKeyPath, /[\\/]\.lgtv-keys-temp[\\/].*aabbccddeeff.*\.key$/);
  assert.match(ipFallbackPath, /[\\/]\.lgtv-keys-temp[\\/].*10\.0\.0\.66.*\.key$/);
  assert.ok(macKeyPath.includes('.lgtv-keys-temp'));
});

test('setKey should register the key by MAC as the primary identity and still resolve by IP alias', () => {
  const store = new DeviceStore(__dirname);
  const mac = 'aa:bb:cc:dd:ee:ff';
  const ip = '10.0.0.88';

  store.registerOrUpdate({ id: 'tv-mac-ip-alias', name: 'MAC Alias TV', ip, mac, group: 'default' });
  const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  store.setKey(mac, key);
  assert.equal(store.getKey(mac), key);
  assert.equal(store.getKey(ip), key);
});

test('clearSavedKeyForDevice should reset stale pairing keys so a newer WebOS TV can re-prompt', () => {
  const store = new DeviceStore(__dirname);
  const manager = new LGTVManager({ store, rootDir: __dirname, logger: console });
  const device = {
    id: 'tv-stale-key',
    name: 'New WebOS TV',
    ip: '10.137.73.62',
    mac: 'aa:bb:cc:dd:ee:ff',
    group: 'default',
  };

  const keyFile = manager.getKeyFilePath(device);
  store.setKey(device.mac, 'stale-client-key');
  store.setKey(device.ip, 'stale-client-key');
  require('fs').writeFileSync(keyFile, 'stale-client-key', 'utf8');

  assert.equal(manager.clearSavedKeyForDevice(device), true);
  assert.equal(store.getKey(device.mac), null);
  assert.equal(store.getKey(device.ip), null);
  assert.equal(require('fs').existsSync(keyFile), false);
  assert.equal(manager.shouldRetryPairingWithFreshKey(new Error('pairing rejected: invalid client-key')), true);
});

test('getRemoteSocket should wait for an already opening socket instead of failing', async () => {
  assert.ok(typeof getRemoteSocket === 'function', 'Debe exponer el helper del socket remoto para evitar bloqueos de concurrencia');

  const tv = { ip: '10.0.0.31', name: 'Touchpad Test TV' };
  const client = {
    getSocket: (_service, cb) => {
      setTimeout(() => {
        const sock = {
          on: () => {},
          send: () => {},
        };
        cb(null, sock);
      }, 25);
    },
  };

  server.clients[tv.ip] = client;
  server.removeRemoteSocket(tv.ip);

  const first = new Promise((resolve, reject) => getRemoteSocket(tv, (err, sock) => err ? reject(err) : resolve(sock)));
  const second = new Promise((resolve, reject) => setTimeout(() => getRemoteSocket(tv, (err, sock) => err ? reject(err) : resolve(sock)), 5));

  const [sockA, sockB] = await Promise.all([first, second]);
  assert.ok(sockA, 'Debe abrir el socket al primer intento');
  assert.ok(sockB, 'Debe reutilizar o esperar el socket cuando el primer intento aún está abriendo');
  assert.equal(sockA, sockB, 'Debe devolver la misma instancia del socket si ya está en uso');
  server.removeRemoteSocket(tv.ip);
  delete server.clients[tv.ip];
});

test('startConnectionHeartbeat should keep the online status active with a lightweight getVolume ping', async () => {
  const store = new DeviceStore(__dirname);
  store.registerOrUpdate({
    id: 'tv-heartbeat',
    name: 'Heartbeat TV',
    ip: '10.0.0.41',
    mac: '11:22:33:44:55:66',
    group: 'default',
  });

  const manager = new LGTVManager({ store, rootDir: __dirname, logger: console });
  manager.ensureConnected = async () => ({
    connection: { connected: true },
    request: async (command) => {
      assert.equal(command, 'ssap://audio/getVolume');
      return { volume: 15 };
    },
  });

  const started = manager.startConnectionHeartbeat();
  assert.equal(started.status, 'ok');
  assert.equal(started.active, true);

  await wait(50);
  const status = manager.getStatus('11:22:33:44:55:66');
  assert.equal(status.online, true);

  manager.stopConnectionHeartbeat();
});
