process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
 
const fs = require('fs');
const express = require('express');
const WebOS = require('lgtv2');
 
const app = express();
app.use(express.json());
app.use(express.static('public'));
 
const tvs = JSON.parse(fs.readFileSync('./tvs.json'));
let keys = {};
 
try {
  keys = JSON.parse(fs.readFileSync('./keys.json'));
} catch {
  keys = {};
}
 
const clients = {};
const status = {};
 
// 💾 guardar keys
function saveKeys() {
  fs.writeFileSync('./keys.json', JSON.stringify(keys, null, 2));
}
 
// 🔌 conectar TV
function connectTV(tv) {
 
  const options = {
    url: `wss://${tv.ip}:3001`
  };
 
  if (keys[tv.ip]) {
    options.clientKey = keys[tv.ip];
  }
 
  const client = WebOS({
  ...options,
  keyFile: './keys.json'
});
 
  clients[tv.ip] = client;
 
  status[tv.ip] = {
    name: tv.name,
    group: tv.group,
    online: false
  };
 
  client.on('connect', () => {
    console.log(`[OK] ${tv.name}`);
    status[tv.ip].online = true;
 
    if (client.clientKey && !keys[tv.ip]) {
      keys[tv.ip] = client.clientKey;
      saveKeys();
      console.log(`[KEY SAVED] ${tv.name}`);
    }
  });
 
  client.on('close', () => {
    status[tv.ip].online = false;
    setTimeout(() => connectTV(tv), 5000);
  });
 
  client.on('error', () => {
    status[tv.ip].online = false;
  });
}
 
// conectar todas
tvs.forEach(connectTV);
 
 
setInterval(() => {
  Object.values(clients).forEach(client => {
    try {
      client.request("ssap://audio/getVolume");
    } catch (e) {}
  });
}, 60000);
 
 
app.get('/api/status', (req, res) => {
  res.json(status);
});
 
app.post('/api/group/:group/volumeUp', (req, res) => {
  tvs.filter(t => t.group === req.params.group)
     .forEach(t => {
       try {
         clients[t.ip].request("ssap://audio/volumeUp");
       } catch {}
     });
 
  res.send("OK");
});
 
app.post('/api/all/off', (req, res) => {
  Object.values(clients).forEach(c => {
    try {
      c.request("ssap://system/turnOff");
    } catch {}
  });
 
  res.send("OK");
});
 
 
app.listen(3000, () => {
  console.log("Panel: http://localhost:3000");
});