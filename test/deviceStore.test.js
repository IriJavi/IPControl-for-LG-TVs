const test = require('node:test');
const assert = require('node:assert/strict');
const { DeviceStore, normalizeMac } = require('../src/deviceStore');
const { parseArpTable } = require('../src/network');

test('normalizeMac should normalize and preserve MAC format', () => {
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('AABBCCDDEEFF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('not-a-mac'), null);
});

test('DeviceStore should register/update devices and store keys', () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const dir = path.join(__dirname, `.tmp-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });

  const store = new DeviceStore(dir);
  const tv = store.registerOrUpdate({
    id: 'tv-01',
    name: 'Living Room',
    ip: '10.0.0.20',
    mac: 'aa-bb-cc-dd-ee-ff',
    group: 'CCR',
  });

  assert.equal(tv.name, 'Living Room');
  assert.equal(store.getDeviceByIp('10.0.0.20').name, 'Living Room');
  assert.equal(store.getKey('aa:bb:cc:dd:ee:ff'), null);

  store.setKey('aa:bb:cc:dd:ee:ff', 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.equal(store.getKey('aa:bb:cc:dd:ee:ff'), 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
});

test('parseArpTable should detect Windows MAC addresses with hyphen separators', () => {
  const raw = [
    'Interface: 192.168.1.10 --- 0x3',
    '  Internet Address      Physical Address      Type',
    '  192.168.1.50          00-11-22-33-44-55     dynamic',
  ].join('\n');

  const parsed = parseArpTable(raw);
  assert.equal(parsed['192.168.1.50'], '00:11:22:33:44:55');
});

test('DeviceStore should filter out devices already in the pool from scan results', () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const dir = path.join(__dirname, `.tmp-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });

  const store = new DeviceStore(dir);
  store.registerOrUpdate({
    id: 'tv-existing',
    name: 'Existing Living Room',
    ip: '10.0.0.10',
    mac: 'aa-bb-cc-dd-ee-ff',
    group: 'default',
  });

  const scans = [
    { id: 'tv-existing', ip: '10.0.0.10', mac: 'aa:bb:cc:dd:ee:ff', name: 'Existing Living Room' },
    { id: 'tv-new', ip: '10.0.0.11', mac: '00:11:22:33:44:55', name: 'New Bedroom' },
  ];

  const filtered = store.filterDiscoveredDevices(scans);
  assert.deepEqual(filtered.map((device) => device.ip), ['10.0.0.11']);
});

test('DeviceStore should normalize legacy key export formats and drop malformed entries', () => {
  const store = new DeviceStore(__dirname);
  const normalized = store.normalizeKeyMap({
    '10.137.73.34': 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    'bc:09:b9:13:d5:1e': 'b1c2d3e4f5a60718293a4b5c6d7e8f90',
    'bc_09_b9_13_d5_1e': 'c1d2e3f4a5b60718293a4b5c6d7e8f90',
    '10.137.73.34.key.mac': '{"wired":"aa:bb:cc","wifi":"dd:ee:ff"}',
    'not-a-key': 'x',
    '10.0.0.1': 'valid-but-short',
  });

  assert.equal(normalized['10.137.73.34'], 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.equal(normalized['bc:09:b9:13:d5:1e'], 'b1c2d3e4f5a60718293a4b5c6d7e8f90');
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'bc_09_b9_13_d5_1e'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, '10.137.73.34.key.mac'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'not-a-key'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, '10.0.0.1'), false);
});
