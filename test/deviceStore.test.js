const test = require('node:test');
const assert = require('node:assert/strict');
const { DeviceStore, normalizeMac } = require('../src/deviceStore');

test('normalizeMac should normalize and preserve MAC format', () => {
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('AABBCCDDEEFF'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(normalizeMac('not-a-mac'), null);
});

test('DeviceStore should register/update devices and store keys', () => {
  const dir = require('node:path').join(__dirname, '.tmp-store');
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

  store.setKey('aa:bb:cc:dd:ee:ff', 'sample-key');
  assert.equal(store.getKey('aa:bb:cc:dd:ee:ff'), 'sample-key');
});
