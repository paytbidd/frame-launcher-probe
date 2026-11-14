/* Frame Launcher — a TizenBrew "app" module.
 * Written in ES5 style: the 2020 Tizen 5.5 browser engine is old Chromium. */
(function () {
  'use strict';

  // ---------- Config ----------
  var params = parseQuery();
  var TV_HOST = params.tv || '127.0.0.1';          // the TV's own REST API (port 8001)
  var STORE_KEY = 'frameLauncher.v1';

  // Known Samsung app IDs. Only installed ones are offered in settings.
  var CATALOG = [
    { id: '111299001912', name: 'YouTube', color: '#ff2a2a' },
    { id: '3201907018807', name: 'Netflix', color: '#e50914' },
    { id: '3201601007625', name: 'Hulu', color: '#1ce783' },
    { id: '3201807016597', name: 'Apple TV', color: '#8e8e93' },
    { id: '3201910019365', name: 'Prime Video', color: '#1f9cff' },
    { id: '3201901017640', name: 'Disney+', color: '#3d6bff' },
    { id: '3201606009684', name: 'Spotify', color: '#1ed760' },
    { id: 'tCyZuSsCVw.Britbox', name: 'BritBox', color: '#c8a2ff' },
    { id: '3201907018784', name: 'Internet', color: '#5ac8fa' }
  ];

  var DEFAULTS = {
    apps: ['111299001912', '3201907018807', '3201601007625'],
    city: null,              // { name, lat, lon }
    units: 'F',
    amp: '192.168.1.159'
  };

  var cfg = loadConfig();
  var installed = {};        // id -> true / false (unknown ids stay undefined)
  var extraApps = [];        // from tizen.application.getAppsInfo, if allowed
  var diag = { tizen: typeof tizen !== 'undefined', appsInfo: 'not tried', launch: 'not used yet' };

  // ---------- Helpers ----------
  function $(id) { return document.getElementById(id); }
  function parseQuery() {
    var out = {}, q = location.search.replace(/^\?/, '').split('&');
    for (var i = 0; i < q.length; i++) {
      if (!q[i]) continue;
      var kv = q[i].split('=');
      out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    }
    return out;
  }
  function loadConfig() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { c = {}; }
    for (var k in DEFAULTS) if (!(k in c)) c[k] = DEFAULTS[k];
    return c;
  }
  function saveConfig() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* storage unavailable */ }
  }
  function appById(id) {
    for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === id) return CATALOG[i];
    for (var j = 0; j < extraApps.length; j++) if (extraApps[j].id === id) return extraApps[j];
    return { id: id, name: id, color: '#666' };
  }
  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }
  function errText(e) { return e ? (e.name ? e.name + ': ' : '') + (e.message || e) : 'unknown error'; }

  // ---------- Clock ----------
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function tickClock() {
    var d = new Date(), h = d.getHours() % 12 || 12, m = d.getMinutes();
    $('time').textContent = h + ':' + (m < 10 ? '0' : '') + m;
    $('date').textContent = DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
  }

  // ---------- App tiles ----------
  function renderApps() {
    var box = $('apps');
    box.innerHTML = '';
    for (var i = 0; i < cfg.apps.length; i++) {
      var a = appById(cfg.apps[i]);
      if (installed[a.id] === false) continue;
      var el = document.createElement('div');
      el.className = 'tile focusable';
      el.setAttribute('data-app', a.id);
      el.style.setProperty('--c', a.color || '#666');
      el.innerHTML = '<div class="name"></div>';
      el.firstChild.textContent = a.name;
      box.appendChild(el);
    }
    var add = document.createElement('div');
    add.className = 'tile add focusable';
    add.setAttribute('data-act', 'settings');
    add.innerHTML = '<div class="name">+</div>';
    box.appendChild(add);
    focus.refresh();
  }

  function launchApp(id) {
    var a = appById(id);
    toast('Opening ' + a.name + '…');
    if (diag.tizen && tizen.application && tizen.application.launch) {
      try {
        tizen.application.launch(id, function () { diag.launch = 'tizen.application.launch'; },
          function (e) { diag.launch = 'tizen failed (' + errText(e) + '), used REST'; launchViaRest(id); });
        return;
      } catch (e) { diag.launch = 'tizen threw (' + errText(e) + '), used REST'; }
    }
    launchViaRest(id);
  }
  function launchViaRest(id) {
    fetch('http://' + TV_HOST + ':8001/api/v2/applications/' + encodeURIComponent(id), { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (diag.launch.indexOf('REST') < 0) diag.launch = 'REST API';
      })
      .catch(function (e) { toast('Could not open app: ' + errText(e)); });
  }

  function checkInstalled() {
    var pending = CATALOG.length;
    CATALOG.forEach(function (a) {
      fetch('http://' + TV_HOST + ':8001/api/v2/applications/' + encodeURIComponent(a.id))
        .then(function (r) { installed[a.id] = r.ok; })
        .catch(function () { /* unknown: leave undefined so it still shows */ })
        .then(function () { if (--pending === 0) { renderApps(); renderSettingsApps(); } });
    });
    if (diag.tizen && tizen.application && tizen.application.getAppsInfo) {
      try {
        tizen.application.getAppsInfo(function (list) {
          diag.appsInfo = list.length + ' apps';
          var known = {};
          CATALOG.forEach(function (a) { known[a.id] = true; });
          extraApps = list.filter(function (x) { return x.show && !known[x.id] && x.id.indexOf('TizenBrew') < 0; })
            .map(function (x) { return { id: x.id, name: x.name, color: '#5b6170' }; })
            .sort(function (p, q) { return p.name.localeCompare(q.name); });
          renderSettingsApps();
        }, function (e) { diag.appsInfo = 'error: ' + errText(e); });
      } catch (e) { diag.appsInfo = 'threw: ' + errText(e); }
    } else diag.appsInfo = 'unavailable';
  }

  // ---------- Weather (Open-Meteo, no API key) ----------
  var WX = {
    0: ['Clear', 'sun'], 1: ['Mostly clear', 'sun'], 2: ['Partly cloudy', 'partly'], 3: ['Overcast', 'cloud'],
    45: ['Fog', 'fog'], 48: ['Fog', 'fog'], 51: ['Light drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Drizzle', 'rain'],
    56: ['Freezing drizzle', 'rain'], 57: ['Freezing drizzle', 'rain'], 61: ['Light rain', 'rain'], 63: ['Rain', 'rain'],
    65: ['Heavy rain', 'rain'], 66: ['Freezing rain', 'rain'], 67: ['Freezing rain', 'rain'], 71: ['Light snow', 'snow'],
    73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'], 80: ['Showers', 'rain'],
    81: ['Showers', 'rain'], 82: ['Heavy showers', 'rain'], 85: ['Snow showers', 'snow'], 86: ['Snow showers', 'snow'],
    95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm', 'storm'], 99: ['Thunderstorm', 'storm']
  };
  var S = 'fill="none" stroke="#45C3C0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  var CLOUD = '<path ' + S + ' d="M17.5 19H8a5 5 0 1 1 1.1-9.9A6 6 0 0 1 20.5 12 3.6 3.6 0 0 1 17.5 19z"/>';
  var ICONS = {
    sun: '<circle ' + S + ' cx="16" cy="16" r="5.5"/><path ' + S + ' d="M16 3v3M16 26v3M3 16h3M26 16h3M6.8 6.8l2.1 2.1M23.1 23.1l2.1 2.1M6.8 25.2l2.1-2.1M23.1 8.9l2.1-2.1"/>',
    moon: '<path ' + S + ' d="M24 19.5A10 10 0 0 1 12.5 8 10 10 0 1 0 24 19.5z"/>',
    partly: '<path ' + S + ' d="M13 6v2M5.5 13H7.5M7.8 7.8l1.4 1.4M18.2 7.8l-1.4 1.4"/><path ' + S + ' d="M9.6 14.2A4 4 0 0 1 16.6 11"/><g transform="translate(3 5)">' + CLOUD + '</g>',
    cloud: '<g transform="translate(2 2)">' + CLOUD + '</g>',
    fog: '<path ' + S + ' d="M5 12h22M8 17h18M5 22h20"/>',
    rain: '<g transform="translate(2 -1)">' + CLOUD + '</g><path ' + S + ' d="M11 23l-1.5 4M16.5 23L15 27M22 23l-1.5 4"/>',
    snow: '<g transform="translate(2 -1)">' + CLOUD + '</g><path ' + S + ' d="M11 24v.1M16 26v.1M21 24v.1"/>',
    storm: '<g transform="translate(2 -1)">' + CLOUD + '</g><path ' + S + ' d="M17 20l-3 5h4l-3 5"/>'
  };

  function loadWeather() {
    if (!cfg.city) {
      $('wx-temp').textContent = '';
      $('wx-desc').textContent = 'Press Blue to set your location';
      $('wx-icon').innerHTML = '';
      return;
    }
    var u = cfg.units === 'C' ? 'celsius' : 'fahrenheit';
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + cfg.city.lat + '&longitude=' + cfg.city.lon +
      '&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min' +
      '&temperature_unit=' + u + '&timezone=auto&forecast_days=1';
    fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      var code = d.current.weather_code, w = WX[code] || ['—', 'cloud'];
      var icon = w[1] === 'sun' && !d.current.is_day ? 'moon' : w[1];
      $('wx-icon').innerHTML = '<svg viewBox="0 0 32 32">' + ICONS[icon] + '</svg>';
      $('wx-temp').textContent = Math.round(d.current.temperature_2m) + '°';
      $('wx-desc').textContent = w[0] + '  ·  H ' + Math.round(d.daily.temperature_2m_max[0]) + '°  L ' +
        Math.round(d.daily.temperature_2m_min[0]) + '°  ·  ' + cfg.city.name;
    }).catch(function () { $('wx-desc').textContent = 'Weather unavailable'; });
  }

  function setCity(text) {
    text = (text || '').trim();
    if (!text) return;
    fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(text))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.results || !d.results.length) { toast('No place called "' + text + '"'); return; }
        var p = d.results[0];
        cfg.city = { name: p.name, lat: p.latitude, lon: p.longitude };
        saveConfig();
        $('in-city').value = p.name + (p.admin1 ? ', ' + p.admin1 : '');
        toast('Weather set to ' + $('in-city').value);
        loadWeather();
      })
      .catch(function () { toast('Could not look up that place'); });
  }

  // ---------- Receiver (BluOS HTTP API, port 11000) ----------
  var np = { state: 'stop', etag: '', secs: 0, totlen: 0, volume: null, actions: {} };
  function ampBase() { return 'http://' + cfg.amp + ':11000'; }
  function tag(doc, name) { var n = doc.getElementsByTagName(name)[0]; return n ? n.textContent : ''; }

  var pollToken = 0;
  function pollStatus() {
    var my = ++pollToken;
    var url = ampBase() + '/Status' + (np.etag ? '?timeout=30&etag=' + np.etag : '');
    fetch(url).then(function (r) { return r.text(); }).then(function (xml) {
      if (my !== pollToken) return;
      applyStatus(new DOMParser().parseFromString(xml, 'application/xml'));
      pollStatus();
    }).catch(function () {
      if (my !== pollToken) return;
      $('player').className = 'player idle';
      $('np-source').textContent = 'Receiver offline';
      $('np-title').textContent = 'Can\'t reach ' + cfg.amp;
      $('np-artist').textContent = '';
      np.etag = '';
      setTimeout(function () { if (my === pollToken) pollStatus(); }, 8000);
    });
  }

  function applyStatus(doc) {
    var root = doc.documentElement;
    np.etag = root.getAttribute('etag') || '';
    np.state = tag(doc, 'state') || 'stop';
    np.secs = parseFloat(tag(doc, 'secs')) || 0;
    np.totlen = parseFloat(tag(doc, 'totlen')) || 0;
    np.volume = tag(doc, 'volume');
    np.actions = {};
    var acts = doc.getElementsByTagName('action');
    for (var i = 0; i < acts.length; i++) np.actions[acts[i].getAttribute('name')] = acts[i].getAttribute('url');

    var title = tag(doc, 'name') || tag(doc, 'title1');
    var artist = tag(doc, 'artist'), album = tag(doc, 'album');
    var sub = [artist, album].filter(function (x) { return x && x !== title; }).join('  —  ') || tag(doc, 'title2');
    var img = tag(doc, 'image');
    if (img && img.charAt(0) === '/') img = ampBase() + img;

    var playing = np.state === 'play' || np.state === 'stream';
    $('player').className = 'player' + (title ? '' : ' idle');
    $('np-source').textContent = (tag(doc, 'serviceName') || 'Receiver') + (playing ? '' : '  ·  ' + np.state);
    $('np-title').textContent = title || 'Nothing playing';
    $('np-artist').textContent = sub;
    $('np-art').style.backgroundImage = img ? 'url("' + img + '")' : '';
    $('np-vol').textContent = np.volume === '' ? '--' : np.volume;
    $('ic-play').style.display = playing ? 'none' : '';
    $('ic-pause').style.display = playing ? '' : 'none';
    drawProgress();
  }

  function drawProgress() {
    $('np-bar').style.width = np.totlen ? Math.min(100, (np.secs / np.totlen) * 100) + '%' : '0';
  }
  setInterval(function () {
    if (np.state === 'play' || np.state === 'stream') { np.secs += 1; drawProgress(); }
  }, 1000);

  function ampCmd(path) {
    fetch(ampBase() + path).catch(function () { toast('Receiver didn\'t respond'); });
  }
  function playerAction(act) {
    var playing = np.state === 'play' || np.state === 'stream';
    if (act === 'toggle') ampCmd(playing ? '/Pause' : '/Play');
    else if (act === 'skip') ampCmd(np.actions.skip || '/Skip');
    else if (act === 'back') ampCmd(np.actions.back || '/Back');
    else if (act === 'volup' || act === 'voldown') {
      var v = parseInt(np.volume, 10);
      if (isNaN(v)) return;
      v = Math.max(0, Math.min(100, v + (act === 'volup' ? 2 : -2)));
      np.volume = String(v);
      $('np-vol').textContent = v;
      ampCmd('/Volume?level=' + v);
    }
  }

  // ---------- Settings ----------
  function renderSettingsApps() {
    var box = $('set-apps');
    box.innerHTML = '';
    var list = CATALOG.filter(function (a) { return installed[a.id] !== false; }).concat(extraApps);
    list.forEach(function (a) {
      var on = cfg.apps.indexOf(a.id) >= 0;
      var el = document.createElement('div');
      el.className = 'item focusable' + (on ? ' on' : '');
      el.setAttribute('data-toggle', a.id);
      el.innerHTML = '<span></span><b>' + (on ? 'On' : 'Off') + '</b>';
      el.firstChild.textContent = a.name;
      box.appendChild(el);
    });
    $('v-units').textContent = cfg.units === 'C' ? '°C' : '°F';
    $('in-city').value = cfg.city ? cfg.city.name : '';
    $('in-amp').value = cfg.amp;
    $('diag').textContent = 'tizen API: ' + (diag.tizen ? 'yes' : 'no') + '\ngetAppsInfo: ' + diag.appsInfo +
      '\nlast launch: ' + diag.launch + '\npage: ' + location.href;
    if (settingsOpen) focus.refresh();
  }

  var settingsOpen = false;
  function openSettings() {
    settingsOpen = true;
    renderSettingsApps();
    $('settings').className = 'settings';
    focus.refresh(0);
  }
  function closeSettings() {
    settingsOpen = false;
    $('settings').className = 'settings hidden';
    renderApps();
  }
  function settingsEnter(el) {
    var id = el.getAttribute('data-toggle');
    if (id) {
      var i = cfg.apps.indexOf(id);
      if (i >= 0) cfg.apps.splice(i, 1); else cfg.apps.push(id);
      saveConfig();
      var idx = focus.index();
      renderSettingsApps();
      focus.refresh(idx);
      return;
    }
    var s = el.getAttribute('data-set');
    if (s === 'units') { cfg.units = cfg.units === 'C' ? 'F' : 'C'; saveConfig(); renderSettingsApps(); loadWeather(); }
    else if (s === 'close') closeSettings();
    else if (s === 'city' || s === 'amp') { var inp = el.getElementsByTagName('input')[0]; inp.focus(); inp.select(); }
  }
  function commitInput(inp) {
    if (inp.id === 'in-city') setCity(inp.value);
    else if (inp.id === 'in-amp') {
      cfg.amp = inp.value.trim() || DEFAULTS.amp;
      saveConfig();
      np.etag = '';
      pollStatus();
      toast('Receiver set to ' + cfg.amp);
    }
    inp.blur();
  }

  // ---------- Focus / remote navigation ----------
  var focus = (function () {
    var row = 0, idx = [0, 0], setIdx = 0;
    function rows() {
      return [
        Array.prototype.slice.call(document.querySelectorAll('#apps .focusable')),
        Array.prototype.slice.call(document.querySelectorAll('#player .focusable'))
      ];
    }
    function setItems() { return Array.prototype.slice.call(document.querySelectorAll('#settings .focusable')); }
    function paint() {
      var all = document.querySelectorAll('.focused');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('focused');
      var el = current();
      if (el) {
        el.classList.add('focused');
        if (settingsOpen && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      }
    }
    function current() {
      if (settingsOpen) return setItems()[setIdx];
      var r = rows()[row];
      return r && r[Math.min(idx[row], r.length - 1)];
    }
    return {
      current: current,
      index: function () { return setIdx; },
      refresh: function (i) {
        if (settingsOpen) {
          var n = setItems().length;
          if (typeof i === 'number') setIdx = i;
          setIdx = Math.max(0, Math.min(setIdx, n - 1));
        }
        paint();
      },
      move: function (dx, dy) {
        if (settingsOpen) {
          setIdx = Math.max(0, Math.min(setItems().length - 1, setIdx + dy));
        } else {
          var r = rows();
          if (dy) row = Math.max(0, Math.min(r.length - 1, row + dy));
          if (dx) idx[row] = Math.max(0, Math.min(r[row].length - 1, Math.min(idx[row], r[row].length - 1) + dx));
        }
        paint();
      }
    };
  })();

  var K = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, NEXT: 10233, PREV: 10232,
    IME_DONE: 65376, IME_CANCEL: 65385
  };

  document.addEventListener('keydown', function (ev) {
    var k = ev.keyCode, t = ev.target;

    // Typing in a settings field: let the on-screen keyboard work.
    if (t && t.tagName === 'INPUT') {
      if (k === K.ENTER || k === K.IME_DONE) { ev.preventDefault(); commitInput(t); }
      else if (k === K.BACK || k === K.ESC || k === K.IME_CANCEL) { ev.preventDefault(); renderSettingsApps(); t.blur(); }
      return;
    }

    switch (k) {
      case K.LEFT: focus.move(-1, 0); break;
      case K.RIGHT: focus.move(1, 0); break;
      case K.UP: focus.move(0, -1); break;
      case K.DOWN: focus.move(0, 1); break;
      case K.ENTER: {
        var el = focus.current();
        if (!el) break;
        if (settingsOpen) settingsEnter(el);
        else if (el.getAttribute('data-app')) launchApp(el.getAttribute('data-app'));
        else if (el.getAttribute('data-act') === 'settings') openSettings();
        else playerAction(el.getAttribute('data-act'));
        break;
      }
      case K.BLUE: settingsOpen ? closeSettings() : openSettings(); break;
      case K.BACK: case K.ESC:
        if (settingsOpen) closeSettings(); else history.back();
        break;
      case K.YELLOW: case K.PLAYPAUSE: playerAction('toggle'); break;
      case K.PLAY: if (np.state !== 'play' && np.state !== 'stream') ampCmd('/Play'); break;
      case K.PAUSE: case K.STOP: ampCmd('/Pause'); break;
      case K.NEXT: playerAction('skip'); break;
      case K.PREV: playerAction('back'); break;
      default: return;
    }
    ev.preventDefault();
  });

  // ---------- Start ----------
  tickClock();
  setInterval(tickClock, 5000);
  renderApps();
  checkInstalled();
  loadWeather();
  setInterval(loadWeather, 15 * 60 * 1000);
  pollStatus();
})();
