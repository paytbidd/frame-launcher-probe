// Frame Launcher service starter. TizenBrew runs this file from the pinned module commit,
// so it must stay tiny and stable. It looks up the newest commit on GitHub, downloads
// service-main.js from that commit and runs it with the same tools (require, tizen),
// so the real service updates without changing the module link. Old Node.js: ES5 only.
var https = require('https');
var vm = require('vm');
var REPO = 'paytbidd/frame-launcher-probe';

function get(opts, cb) {
  var req = https.get(opts, function (res) {
    var body = '';
    res.setEncoding('utf8');
    res.on('data', function (c) { body += c; });
    res.on('end', function () { cb(res.statusCode === 200 ? null : new Error('HTTP ' + res.statusCode), body); });
  });
  req.on('error', function (e) { cb(e); });
  req.setTimeout(10000, function () { req.abort(); });
}

function run(ref) {
  get('https://cdn.jsdelivr.net/gh/' + REPO + '@' + ref + '/service-main.js', function (err, code) {
    if (err) {
      if (ref !== 'main') return run('main');      // last resort: the branch copy
      return console.error('frame-launcher: could not load service', err);
    }
    var sandbox = { require: require, SERVICE_VERSION: ref };
    // Pass along whichever of these globals exist in this sandbox.
    if (typeof tizen !== 'undefined') sandbox.tizen = tizen;
    if (typeof console !== 'undefined') sandbox.console = console;
    if (typeof setTimeout !== 'undefined') sandbox.setTimeout = setTimeout;
    if (typeof clearTimeout !== 'undefined') sandbox.clearTimeout = clearTimeout;
    if (typeof setInterval !== 'undefined') sandbox.setInterval = setInterval;
    if (typeof clearInterval !== 'undefined') sandbox.clearInterval = clearInterval;
    if (typeof Buffer !== 'undefined') sandbox.Buffer = Buffer;
    if (typeof process !== 'undefined') sandbox.process = process;
    try { vm.runInContext(code, vm.createContext(sandbox)); }
    catch (e) { console.error('frame-launcher: service crashed', e); }
  });
}

get({
  hostname: 'api.github.com',
  path: '/repos/' + REPO + '/commits/main',
  headers: { 'User-Agent': 'frame-launcher', Accept: 'application/vnd.github.sha' }
}, function (err, sha) {
  sha = (sha || '').trim();
  run(!err && /^[0-9a-f]{40}$/.test(sha) ? sha : 'main');
});
