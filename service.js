// Frame Launcher background service. TizenBrew runs this inside its own service
// (old Node.js, with the TV's `tizen` API), which can launch apps the web page can't.
// The page talks to it over http://127.0.0.1:8095. Keep this file small and stable:
// TizenBrew loads it from the pinned commit, so changes here need a new module link.
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

var server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  var hasTizen = typeof tizen !== 'undefined' && !!tizen.application;

  if (u.pathname === '/ping') return send(res, 200, { ok: true, tizen: hasTizen, version: 1 });
  if (!hasTizen) return send(res, 500, { ok: false, error: 'tizen API not available in service' });

  if (u.pathname === '/launch') {
    var id = u.query.id;
    if (!id) return send(res, 400, { ok: false, error: 'missing id' });
    try {
      tizen.application.launch(id,
        function () { send(res, 200, { ok: true, id: id }); },
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
