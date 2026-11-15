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

var server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  var hasTizen = typeof tizen !== 'undefined' && !!tizen.application;

  if (u.pathname === '/ping') return send(res, 200, { ok: true, tizen: hasTizen, version: typeof SERVICE_VERSION !== 'undefined' ? SERVICE_VERSION : 'local', watching: Object.keys(watched), events: events });
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
