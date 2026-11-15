// Frame Launcher background service (the real code). service.js, the starter TizenBrew
// runs, downloads this file from the newest commit and runs it with the same sandbox, so it
// updates without a new module link. Runs on old Node.js (TizenBrew service): ES5 only.
var http = require('http');
var url = require('url');
var PORT = 8095;

function send(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function errText(e) {
  return e ? (e.name ? e.name + ': ' : '') + (e.message || String(e)) : 'unknown error';
}


// ---- Return to launcher -------------------------------------------------------------
// Apps opened from the launcher with ret=1 are watched. When one is no longer running
// (it was exited, not just sent to the background with Home), TizenBrew is reopened on
// our module. Polls only while something is being watched.
var watched = {};        // appId -> { mod, seen }
var events = [];         // recent activity, shown in the launcher's settings for debugging
var pollTimer = null;

function note(msg) {
  events.unshift(new Date().toTimeString().slice(0, 8) + ' ' + msg);
  if (events.length > 6) events.length = 6;
}

function reopenLauncher(mod) {
  try {
    var pkg = tizen.application.getAppInfo().packageId;
    var slash = mod.indexOf('/');
    var data = JSON.stringify({ moduleType: mod.slice(0, slash), moduleName: mod.slice(slash + 1) });
    var ctl = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/default', null, null, null,
      [new tizen.ApplicationControlData('module', [data])]);
    tizen.application.launchAppControl(ctl, pkg + '.TizenBrewStandalone',
      function () { note('reopened launcher'); },
      function (e) { note('reopen failed: ' + errText(e)); });
  } catch (e) { note('reopen threw: ' + errText(e)); }
}

function poll() {
  var ids = Object.keys(watched);
  if (!ids.length) { clearInterval(pollTimer); pollTimer = null; return; }
  try {
    tizen.application.getAppsContext(function (ctxs) {
      var running = {};
      ctxs.forEach(function (c) { running[c.appId] = true; });
      ids.forEach(function (id) {
        var w = watched[id];
        if (!w) return;
        if (running[id]) { w.seen = true; return; }
        if (w.seen) {                       // was running, now gone: the user exited it
          delete watched[id];
          note(id + ' closed');
          reopenLauncher(w.mod);
        } else if (Date.now() - w.since > 20000) {
          delete watched[id];               // never showed up as running; stop watching
          note(id + ' never seen running');
        }
      });
    }, function (e) { note('getAppsContext error: ' + errText(e)); });
  } catch (e) { note('getAppsContext threw: ' + errText(e)); }
}

function watch(id, mod) {
  watched[id] = { mod: mod, seen: false, since: Date.now() };
  note('watching ' + id);
  if (!pollTimer) pollTimer = setInterval(poll, 2000);
}

// ---- Album art in Art Mode -----------------------------------------------------------
// Follows the BluOS amp (NAD C700). When a new track with artwork is playing and the Frame is
// in Art Mode, the cover is uploaded with a matte, shown, and the previous upload deleted, so
// only one of ours ever exists. After RESTORE_AFTER of no music, the artwork that was up
// before is shown again and our upload is deleted. Nothing else in Art Mode is touched.
// The 2020 Frame quirks handled here: its art service joins the channel a few seconds after
// connecting (wait for ms.channel.ready), and select_image is applied but never answered.
var tls = require('tls');
var net = require('net');
var crypto = require('crypto');
var fs = require('fs');

var STORE = typeof FL_STORE !== 'undefined' ? FL_STORE : '/home/owner/share/frameLauncher.json';
var TV_HOST = typeof FL_TV !== 'undefined' ? FL_TV : '127.0.0.1';
var CLIENT_NAME = typeof FL_NAME !== 'undefined' ? FL_NAME : 'FrameLauncher';
var RESTORE_AFTER = typeof FL_RESTORE_AFTER !== 'undefined' ? FL_RESTORE_AFTER : 180000;

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { return {}; }
}
var store = loadStore();
if (store.artEnabled === undefined) store.artEnabled = true;
if (!store.matte) store.matte = 'shadowbox_black';
if (typeof FL_TOKEN !== 'undefined') store.token = FL_TOKEN;
function saveStore() {
  try { fs.writeFileSync(STORE, JSON.stringify(store)); } catch (e) { note('art: could not save settings: ' + errText(e)); }
}

// Minimal websocket client (wss, text frames) — the service has no websocket library.
function WsClient(host, port, path, onMessage, onClose) {
  var self = this, buf = new Buffer(0), open = false;
  self.sock = tls.connect({ host: host, port: port, rejectUnauthorized: false }, function () {
    self.sock.write('GET ' + path + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\nUpgrade: websocket\r\n' +
      'Connection: Upgrade\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') +
      '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  self.sock.on('data', function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (!open) {
      var end = buf.toString('binary').indexOf('\r\n\r\n');
      if (end < 0) return;
      if (buf.toString('utf8', 0, 12).indexOf('101') < 0) { self.close(); return; }
      open = true;
      buf = buf.slice(end + 4);
    }
    while (buf.length >= 2) {
      var op = buf[0] & 0x0f, len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      if (buf.length < off + len) return;
      var payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (op === 1) onMessage(payload.toString('utf8'));
      else if (op === 9) self._frame(10, payload);
      else if (op === 8) self.close();
    }
  });
  self.sock.on('error', function () { self.close(); });
  self.sock.on('close', function () { if (onClose) { var f = onClose; onClose = null; f(); } });
}
WsClient.prototype._frame = function (op, data) {
  var len = data.length, head;
  if (len < 126) { head = new Buffer(2); head[1] = 0x80 | len; }
  else if (len < 65536) { head = new Buffer(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = new Buffer(10); head.fill(0); head[1] = 0x80 | 127; head.writeUInt32BE(len, 6); }
  head[0] = 0x80 | op;
  var mask = crypto.randomBytes(4), body = new Buffer(len);
  for (var i = 0; i < len; i++) body[i] = data[i] ^ mask[i % 4];
  try { this.sock.write(Buffer.concat([head, mask, body])); } catch (e) {}
};
WsClient.prototype.send = function (text) { this._frame(1, new Buffer(text, 'utf8')); };
WsClient.prototype.close = function () { try { this.sock.destroy(); } catch (e) {} };

// One connection to the TV's art service. cb(err, session) once it is ready.
function ArtSession(cb) {
  var self = this, done = false, waiters = [];
  self.waiters = waiters;
  function finish(err) { if (!done) { done = true; clearTimeout(t); cb(err, err ? null : self); } }
  var t = setTimeout(function () { self.close(); finish(new Error('art service not ready (TV not in Art Mode?)')); }, 15000);
  var path = '/api/v2/channels/com.samsung.art-app?name=' + new Buffer(CLIENT_NAME).toString('base64') +
    (store.token ? '&token=' + store.token : '');
  self.ws = new WsClient(TV_HOST, 8002, path, function (text) {
    var m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (m.event === 'ms.channel.connect' && m.data && m.data.token && m.data.token !== store.token) {
      store.token = m.data.token; saveStore();
    } else if (m.event === 'ms.channel.unauthorized') {
      self.close(); finish(new Error('not allowed on the TV yet — accept the prompt'));
    } else if (m.event === 'ms.channel.ready') {
      finish(null);
    } else if (m.event === 'd2d_service_message') {
      var d;
      try { d = JSON.parse(m.data); } catch (e) { return; }
      for (var i = 0; i < waiters.length; i++) {
        var w = waiters[i];
        if ((w.id && (d.request_id || d.id) !== w.id) || (w.sub && d.event !== w.sub)) continue;
        if (!w.sub && d.event === 'error') { waiters.splice(i, 1); clearTimeout(w.t); w.cb(new Error('TV error ' + d.error_code)); return; }
        waiters.splice(i, 1); clearTimeout(w.t); w.cb(null, d); return;
      }
    }
  }, function () { finish(new Error('art connection closed')); });
}
ArtSession.prototype.wait = function (id, sub, ms, cb) {
  var waiters = this.waiters, w = { id: id, sub: sub, cb: cb };
  w.t = setTimeout(function () {
    var i = waiters.indexOf(w);
    if (i >= 0) waiters.splice(i, 1);
    cb(new Error('no ' + (sub || 'reply') + ' from TV'));
  }, ms);
  waiters.push(w);
};
ArtSession.prototype.send = function (data) {
  this.ws.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'art_app_request', to: 'host', data: JSON.stringify(data) } }));
};
ArtSession.prototype.request = function (req, extra, cb) {
  var id = crypto.randomBytes(16).toString('hex'), data = { request: req, id: id, request_id: id };
  for (var k in extra) data[k] = extra[k];
  this.wait(id, null, 15000, cb);
  this.send(data);
};
ArtSession.prototype.select = function (contentId) {      // applied by the TV, never answered
  var id = crypto.randomBytes(16).toString('hex');
  this.send({ request: 'select_image', id: id, request_id: id, content_id: contentId, category_id: null, show: true });
};
ArtSession.prototype.upload = function (jpeg, matte, cb) {
  var self = this, id = crypto.randomBytes(16).toString('hex');
  var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
  self.wait(id, 'ready_to_use', 20000, function (err, ready) {
    if (err) return cb(err);
    var ci = typeof ready.conn_info === 'string' ? JSON.parse(ready.conn_info) : ready.conn_info;
    var header = new Buffer(JSON.stringify({ num: 0, total: 1, fileLength: jpeg.length, fileName: 'image',
      fileType: 'jpg', secKey: ci.key, version: '0.0.1' }), 'ascii');
    var len = new Buffer(4); len.writeUInt32BE(header.length, 0);
    self.wait(null, 'image_added', 30000, function (err2, added) { cb(err2, added && added.content_id); });
    var onConn = function () { sock.end(Buffer.concat([len, header, jpeg])); };
    var sock = ci.secured ? tls.connect({ host: ci.ip, port: +ci.port, rejectUnauthorized: false }, onConn)
                          : net.connect(+ci.port, ci.ip, onConn);
    sock.on('error', function (e) { note('art: upload socket ' + errText(e)); });
  });
  self.send({ request: 'send_image', id: id, request_id: id, file_type: 'jpg', file_size: jpeg.length,
    image_date: d.getFullYear() + ':' + p(d.getMonth() + 1) + ':' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()),
    matte_id: matte, portrait_matte_id: matte,
    conn_info: { d2d_mode: 'socket', connection_id: Math.floor(Math.random() * 4294967296), id: id } });
};
ArtSession.prototype.close = function () { if (this.ws) this.ws.close(); };

function getBytes(link, cb) {
  var mod = link.indexOf('https:') === 0 ? require('https') : http;
  var req = mod.get(link, function (res) {
    if (res.statusCode !== 200) { res.resume(); return cb(new Error('HTTP ' + res.statusCode)); }
    var parts = [];
    res.on('data', function (c) { parts.push(c); });
    res.on('end', function () { cb(null, Buffer.concat(parts)); });
  });
  req.on('error', cb);
  req.setTimeout(65000, function () { req.abort(); });
}

var art = { etag: '', shownKey: null, triedKey: null, lastTry: 0, idleSince: null, busy: false, status: 'starting', polling: false };

function ampBase() { return 'http://' + (store.amp || '192.168.1.159') + ':11000'; }
function xmlTag(xml, name) {
  var m = xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") : '';
}

function artPoll() {
  art.polling = true;
  getBytes(ampBase() + '/Status' + (art.etag ? '?timeout=50&etag=' + encodeURIComponent(art.etag) : ''), function (err, body) {
    if (err) { art.status = 'amp unreachable'; art.etag = ''; return setTimeout(artPoll, 15000); }
    var xml = body.toString('utf8'), m = xml.match(/<status[^>]*etag="([^"]*)"/);
    art.etag = m ? m[1] : '';
    var img = xmlTag(xml, 'image');
    if (img.charAt(0) === '/') img = ampBase() + img;
    artHandle({ state: xmlTag(xml, 'state') || 'stop', title: xmlTag(xml, 'name') || xmlTag(xml, 'title1'), image: img });
    setTimeout(artPoll, 200);
  });
}

function artHandle(st) {
  if (!store.artEnabled) {
    art.status = 'off';
    if (store.uploaded && !art.busy) artRestore();     // turned off: put the original art back
    return;
  }
  var playing = st.state === 'play' || st.state === 'stream', now = Date.now();
  if (playing && st.image) {
    art.idleSince = null;
    var key = st.image;
    if (key !== art.shownKey && !art.busy && (key !== art.triedKey || now - art.lastTry > 60000)) {
      art.triedKey = key; art.lastTry = now;
      artShow(st, key);
    }
  } else if (!playing) {
    art.idleSince = art.idleSince || now;
    if (store.uploaded && !art.busy && now - art.idleSince > RESTORE_AFTER) artRestore();
  }
}

function artShow(st, key) {
  art.busy = true;
  function end(msg) { art.busy = false; if (msg) { art.status = msg; note('art: ' + msg); } }
  getBytes(st.image, function (err, cover) {
    if (err) return end('cover download failed (' + errText(err) + ')');
    new ArtSession(function (err2, s) {
      if (err2) return end(errText(err2));
      s.request('get_artmode_status', {}, function (err3, r) {
        if (err3 || !r || r.value !== 'on') { s.close(); return end(err3 ? errText(err3) : 'waiting for Art Mode'); }
        var next = function () {
          s.upload(cover, store.matte, function (err4, newId) {
            if (err4 || !newId) { s.close(); return end('upload failed (' + errText(err4) + ')'); }
            var old = store.uploaded;
            store.uploaded = newId; saveStore();
            s.select(newId);
            setTimeout(function () {
              var fin = function () { s.close(); art.shownKey = key; art.status = 'showing ' + (st.title || newId); end(); note('art: showing ' + (st.title || newId)); };
              if (old && old !== newId) s.request('delete_image_list', { content_id_list: [{ content_id: old }] }, fin);
              else fin();
            }, 3000);
          });
        };
        if (!store.uploaded && !store.restore) {
          // First takeover: remember what's up so it can be put back.
          s.request('get_current_artwork', {}, function (e, cur) {
            if (!e && cur && cur.content_id) { store.restore = cur.content_id; saveStore(); }
            next();
          });
        } else next();
      });
    });
  });
}

function artRestore() {
  art.busy = true;
  new ArtSession(function (err, s) {
    if (err) { art.busy = false; art.idleSince = Date.now(); return; }   // try again later
    if (store.restore) s.select(store.restore);
    setTimeout(function () {
      s.request('delete_image_list', { content_id_list: [{ content_id: store.uploaded }] }, function () {
        note('art: restored ' + (store.restore || 'previous art'));
        store.uploaded = ''; saveStore();
        art.shownKey = null; art.status = 'idle'; art.busy = false;
        s.close();
      });
    }, store.restore ? 3000 : 0);
  });
}

if (!(typeof FL_NO_ART_POLL !== 'undefined' && FL_NO_ART_POLL)) artPoll();

var server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  var hasTizen = typeof tizen !== 'undefined' && !!tizen.application;

  if (u.pathname === '/ping') return send(res, 200, { ok: true, tizen: hasTizen, version: typeof SERVICE_VERSION !== 'undefined' ? SERVICE_VERSION : 'local', watching: Object.keys(watched), events: events,
    art: { enabled: store.artEnabled, matte: store.matte, status: art.status, paired: !!store.token } });

  if (u.pathname === '/config') {
    // Settings from the launcher page: amp address, album art on/off, matte.
    var changedAmp = u.query.amp && u.query.amp !== store.amp;
    if (u.query.amp) store.amp = u.query.amp;
    if (u.query.art === '1' || u.query.art === '0') store.artEnabled = u.query.art === '1';
    if (u.query.matte && /^[a-z]+(_[a-z]+)?$/.test(u.query.matte)) store.matte = u.query.matte;
    saveStore();
    if (changedAmp) art.etag = '';
    return send(res, 200, { ok: true, art: { enabled: store.artEnabled, matte: store.matte, amp: store.amp } });
  }
  if (!hasTizen) return send(res, 500, { ok: false, error: 'tizen API not available in service' });

  if (u.pathname === '/launch') {
    var id = u.query.id;
    if (!id) return send(res, 400, { ok: false, error: 'missing id' });
    try {
      tizen.application.launch(id,
        function () {
          if (u.query.ret === '1' && u.query.mod) watch(id, u.query.mod);
          send(res, 200, { ok: true, id: id });
        },
        function (e) { send(res, 500, { ok: false, error: errText(e) }); });
    } catch (e) {
      send(res, 500, { ok: false, error: errText(e) });
    }
    return;
  }

  if (u.pathname === '/apps') {
    try {
      tizen.application.getAppsInfo(function (list) {
        send(res, 200, {
          ok: true,
          apps: list.map(function (a) { return { id: a.id, name: a.name, show: a.show }; })
        });
      }, function (e) { send(res, 500, { ok: false, error: errText(e) }); });
    } catch (e) {
      send(res, 500, { ok: false, error: errText(e) });
    }
    return;
  }

  send(res, 404, { ok: false, error: 'not found' });
});

server.on('error', function (e) {
  // EADDRINUSE means a copy of this service is already running; that one will answer.
  if (e.code !== 'EADDRINUSE') console.error('frame-launcher service error', e);
});
server.listen(PORT, '127.0.0.1');
