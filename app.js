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
    { id: '111299001912', name: 'YouTube', color: '#ff2a2a', icon: 'icons/youtube.png' },
    { id: '3201907018807', name: 'Netflix', color: '#e50914', icon: 'icons/netflix.png' },
    { id: '3201601007625', name: 'Hulu', color: '#1ce783', icon: 'icons/hulu.png' },
    { id: '3201807016597', name: 'Apple TV', color: '#8e8e93', icon: 'icons/appletv.png' },
    { id: '3201910019365', name: 'Prime Video', color: '#1f9cff', icon: 'icons/primevideo.png' },
    { id: '3201901017640', name: 'Disney+', color: '#3d6bff', icon: 'icons/disneyplus.png' },
    { id: '3201606009684', name: 'Spotify', color: '#1ed760', icon: 'icons/spotify.png' },
    { id: 'tCyZuSsCVw.Britbox', name: 'BritBox', color: '#c8a2ff', icon: 'icons/britbox.png' },
    { id: '3201907018784', name: 'Internet', color: '#5ac8fa', icon: 'icons/internet.svg' }
  ];

  var DEFAULTS = {
    apps: ['111299001912', '3201907018807', '3201601007625'],
    weather: null,           // { zip, place, hourly, daily } — NWS forecast URLs
    units: 'F',
    returnHome: true,        // reopen the launcher when an app it opened is closed
    artMode: true,           // service shows the C700's album art in Art Mode
    matte: 'shadowbox_black',
    amp: '192.168.1.159'
  };

  var cfg = loadConfig();
  var installed = {};        // id -> true / false (unknown ids stay undefined)
  var extraApps = [];        // from tizen.application.getAppsInfo, if allowed
  var diag = { tizen: typeof tizen !== 'undefined', appsInfo: 'not tried', launch: 'not used yet', service: 'checking…' };

  // ---------- Helpers ----------
  function $(id) { return document.getElementById(id); }
  // Tolerate missing elements so a markup/script mismatch can't break the whole page.
  function setText(id, v) { var el = $(id); if (el) el.textContent = v; }
  function setVal(id, v) { var el = $(id); if (el) el.value = v; }
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
    setText('fs-clock', $('time').textContent);
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
      el.innerHTML = (a.icon ? '<img class="icon" alt="">' : '<div class="icon blank"></div>') + '<div class="name"></div>';
      if (a.icon) el.firstChild.src = a.icon;
      el.lastChild.textContent = a.name;
      box.appendChild(el);
    }
    var add = document.createElement('div');
    add.className = 'tile add focusable';
    add.setAttribute('data-act', 'settings');
    add.innerHTML = '<div class="name">+</div>';
    box.appendChild(add);
    focus.refresh();
  }

  var SERVICE = 'http://127.0.0.1:8095';
  var MATTES = [
    ['shadowbox_black', 'Shadowbox · black'], ['shadowbox_polar', 'Shadowbox · white'],
    ['modern_black', 'Modern · black'], ['modern_warm', 'Modern · warm'],
    ['modernthin_black', 'Thin · black'], ['none', 'No matte']
  ];
  function matteLabel(id) {
    for (var i = 0; i < MATTES.length; i++) if (MATTES[i][0] === id) return MATTES[i][1];
    return id;
  }
  // Tell the background service the settings it needs (amp address, album art options).
  function syncService() {
    fetch(SERVICE + '/config?amp=' + encodeURIComponent(cfg.amp) + '&art=' + (cfg.artMode ? 1 : 0) +
      '&matte=' + encodeURIComponent(cfg.matte)).catch(function () {});
  }
  // TizenBrew serves this page at /module/<module name, URL-encoded>/index.html
  function moduleName() {
    var m = location.pathname.match(/\/module\/([^\/]+)\//);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function launchApp(id) {
    var a = appById(id);
    toast('Opening ' + a.name + '…');
    // 1) Our TizenBrew background service (has the TV's tizen API). 2) tizen in-page. 3) TV REST API.
    var mod = moduleName();
    var q = '/launch?id=' + encodeURIComponent(id) + (cfg.returnHome && mod ? '&ret=1&mod=' + encodeURIComponent(mod) : '');
    fetch(SERVICE + q)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || 'service error');
        diag.launch = 'service';
      })
      .catch(function (e) {
        diag.launch = 'service failed (' + errText(e) + ')';
        launchFallback(id);
      });
  }
  function launchFallback(id) {
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
        diag.launch += ' → REST API';
      })
      .catch(function (e) { toast('Could not open app: ' + errText(e)); diag.launch += ' → REST failed (' + errText(e) + ')'; });
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

  // ---------- Weather (US: ZIP via zippopotam.us, forecast via National Weather Service; no keys) ----------
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

  function iconFor(text, isDay) {
    var t = (text || '').toLowerCase();
    if (/thunder|t-storm/.test(t)) return 'storm';
    if (/snow|sleet|flurr|ice|wintry/.test(t)) return 'snow';
    if (/rain|shower|drizzle/.test(t)) return 'rain';
    if (/fog|haze|smoke|mist/.test(t)) return 'fog';
    if (/partly|mostly sunny|mostly clear/.test(t)) return 'partly';
    if (/cloud|overcast/.test(t)) return 'cloud';
    return isDay ? 'sun' : 'moon';
  }
  function temp(f) { return Math.round(cfg.units === 'C' ? (f - 32) * 5 / 9 : f) + '°'; }
  function getJSON(url) {
    return fetch(url, { headers: { Accept: 'application/geo+json' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function loadWeather() {
    if (!cfg.weather) {
      $('wx-temp').textContent = '';
      $('wx-desc').textContent = 'Press Blue to set your ZIP code';
      $('wx-icon').innerHTML = '';
      return;
    }
    Promise.all([getJSON(cfg.weather.hourly), getJSON(cfg.weather.daily)]).then(function (res) {
      var now = res[0].properties.periods[0], days = res[1].properties.periods.slice(0, 3);
      var hi = null, lo = null;
      days.forEach(function (p) {
        if (p.isDaytime && hi === null) hi = p.temperature;
        if (!p.isDaytime && lo === null) lo = p.temperature;
      });
      $('wx-icon').innerHTML = '<svg viewBox="0 0 32 32">' + ICONS[iconFor(now.shortForecast, now.isDaytime)] + '</svg>';
      $('wx-temp').textContent = temp(now.temperature);
      $('wx-desc').textContent = now.shortForecast +
        (hi !== null ? '  ·  H ' + temp(hi) : '') + (lo !== null ? '  L ' + temp(lo) : '') + '  ·  ' + cfg.weather.place;
    }).catch(function () { $('wx-desc').textContent = 'Weather unavailable'; });
  }

  function setZip(text) {
    var zip = (text || '').replace(/\D/g, '').slice(0, 5);
    if (zip.length !== 5) { toast('Enter a 5-digit ZIP code'); return; }
    var place;
    fetch('https://api.zippopotam.us/us/' + zip)
      .then(function (r) { if (!r.ok) throw new Error('unknown ZIP'); return r.json(); })
      .then(function (d) {
        var p = d.places[0];
        place = { name: p['place name'] + ', ' + p['state abbreviation'], lat: (+p.latitude).toFixed(4), lon: (+p.longitude).toFixed(4) };
        return getJSON('https://api.weather.gov/points/' + place.lat + ',' + place.lon);
      })
      .then(function (pt) {
        cfg.weather = { zip: zip, place: place.name, hourly: pt.properties.forecastHourly, daily: pt.properties.forecast };
        saveConfig();
        setVal('in-zip', zip);
        toast('Weather set to ' + place.name);
        loadWeather();
      })
      .catch(function (e) { toast('Couldn\'t find weather for ' + zip + (e && e.message === 'unknown ZIP' ? ' (unknown ZIP)' : '')); });
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
    setPlayIcons(playing);
    // Full-screen view
    setText('fs-source', (tag(doc, 'serviceName') || 'Now playing') + (playing || !title ? '' : '  ·  ' + np.state));
    setText('fs-title', title || 'Nothing playing');
    setText('fs-artist', artist && artist !== title ? artist : (tag(doc, 'title2') || ''));
    setText('fs-album', album && album !== title ? album : '');
    setText('fs-vol', np.volume === '' ? '--' : np.volume);
    var art = img ? 'url("' + img + '")' : '';
    if ($('fs-art')) $('fs-art').style.backgroundImage = art;
    if ($('fs-bg')) $('fs-bg').style.backgroundImage = art;
    drawProgress();
  }

  function drawProgress() {
    var w = np.totlen ? Math.min(100, (np.secs / np.totlen) * 100) + '%' : '0';
    $('np-bar').style.width = w;
    if ($('fs-bar')) $('fs-bar').style.width = w;
    setText('fs-pos', np.totlen ? mmss(Math.min(np.secs, np.totlen)) : '');
    setText('fs-len', np.totlen ? mmss(np.totlen) : '');
  }
  function mmss(t) { t = Math.floor(t); return Math.floor(t / 60) + ':' + (t % 60 < 10 ? '0' : '') + (t % 60); }
  function setPlayIcons(playing) {
    var a = document.querySelectorAll('.ic-play'), b = document.querySelectorAll('.ic-pause'), i;
    for (i = 0; i < a.length; i++) a[i].style.display = playing ? 'none' : '';
    for (i = 0; i < b.length; i++) b[i].style.display = playing ? '' : 'none';
  }

  // ---------- Full-screen now playing ----------
  var fsOpen = false;
  function openFs() {
    fsOpen = true;
    $('fs').className = 'fs';
    focus.refresh(1);                                  // start on play/pause
  }
  function closeFs() {
    fsOpen = false;
    $('fs').className = 'fs hidden';
    focus.refresh();
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
  function pingService(after) {
    fetch(SERVICE + '/ping').then(function (r) { return r.json(); })
      .then(function (d) {
        diag.service = d.ok ? 'running ' + String(d.version).slice(0, 7) + ' (tizen ' + (d.tizen ? 'yes' : 'no') + ')' : 'error';
        diag.art = d.art ? (d.art.enabled ? d.art.status : 'off') + (d.art.paired ? '' : ' · not paired yet') : 'n/a';
        diag.watch = (d.watching && d.watching.length ? 'watching ' + d.watching.join(', ') : 'idle') +
          (d.events && d.events.length ? '\n  ' + d.events.join('\n  ') : '');
      })
      .catch(function () { diag.service = 'not running'; diag.watch = ''; })
      .then(function () { if (after) after(); });
  }

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
    setText('v-units', cfg.units === 'C' ? '°C' : '°F');
    setText('v-return', cfg.returnHome ? 'On' : 'Off');
    setText('v-artmode', cfg.artMode ? 'On' : 'Off');
    setText('v-matte', matteLabel(cfg.matte));
    var ai = document.querySelector('[data-set="artmode"]');
    if (ai) ai.className = 'item focusable' + (cfg.artMode ? ' on' : '') + (ai.classList.contains('focused') ? ' focused' : '');
    var ri = document.querySelector('[data-set="return"]');
    if (ri) ri.className = 'item focusable' + (cfg.returnHome ? ' on' : '') + (ri.classList.contains('focused') ? ' focused' : '');
    setVal('in-zip', cfg.weather ? cfg.weather.zip : '');
    setVal('in-amp', cfg.amp);
    setText('diag',  'service: ' + diag.service + '\ntizen in page: ' + (diag.tizen ? 'yes' : 'no') + '\ngetAppsInfo: ' + diag.appsInfo +
      '\nlast launch: ' + diag.launch + '\nart mode: ' + (diag.art || '—') + '\nreturn watcher: ' + (diag.watch || '—') + '\nversion: ' + (document.querySelector('base') ? document.querySelector('base').href : location.href));
    if (settingsOpen) focus.refresh();
  }

  var settingsOpen = false;
  function openSettings() {
    settingsOpen = true;
    renderSettingsApps();
    pingService(function () { if (settingsOpen) renderSettingsApps(); });
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
    if (s === 'return') { cfg.returnHome = !cfg.returnHome; saveConfig(); renderSettingsApps(); }
    else if (s === 'artmode') { cfg.artMode = !cfg.artMode; saveConfig(); syncService(); renderSettingsApps(); }
    else if (s === 'matte') {
      var mi = 0;
      for (var j = 0; j < MATTES.length; j++) if (MATTES[j][0] === cfg.matte) mi = j;
      cfg.matte = MATTES[(mi + 1) % MATTES.length][0];
      saveConfig(); syncService(); renderSettingsApps();
    }
    else if (s === 'units') { cfg.units = cfg.units === 'C' ? 'F' : 'C'; saveConfig(); renderSettingsApps(); loadWeather(); }
    else if (s === 'close') closeSettings();
    else if (s === 'zip' || s === 'amp') { var inp = el.getElementsByTagName('input')[0]; inp.focus(); inp.select(); }
  }
  function commitInput(inp) {
    if (inp.id === 'in-zip') setZip(inp.value);
    else if (inp.id === 'in-amp') {
      cfg.amp = inp.value.trim() || DEFAULTS.amp;
      saveConfig();
      np.etag = '';
      pollStatus();
      toast('Receiver set to ' + cfg.amp);
      syncService();
    }
    inp.blur();
  }

  // ---------- Focus / remote navigation ----------
  var focus = (function () {
    var row = 0, idx = [0, 0], setIdx = 0, fsIdx = 1;
    function rows() {
      return [
        Array.prototype.slice.call(document.querySelectorAll('#apps .focusable')),
        Array.prototype.slice.call(document.querySelectorAll('#player .focusable'))
      ];
    }
    function setItems() { return Array.prototype.slice.call(document.querySelectorAll('#settings .focusable')); }
    function fsItems() { return Array.prototype.slice.call(document.querySelectorAll('#fs .focusable')); }
    function paint() {
      var all = document.querySelectorAll('.focused');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('focused');
      var el = current();
      if (el) {
        el.classList.add('focused');
        if (settingsOpen && el.scrollIntoView) {
          el.scrollIntoView({ block: 'nearest' });
          // On the last item (Done), show the status text below it too.
          if (el.getAttribute('data-set') === 'close') {
            var panel = document.querySelector('#settings .panel');
            if (panel) panel.scrollTop = panel.scrollHeight;
          }
        }
        var box = el.parentNode;
        if (box && box.id === 'apps') {
          // Keep the focused tile inside the 120px side margins, scrolling the row as needed.
          var left = el.offsetLeft - 120, right = el.offsetLeft + el.offsetWidth + 120 - box.clientWidth;
          if (box.scrollLeft > left) box.scrollLeft = left;
          else if (box.scrollLeft < right) box.scrollLeft = right;
        }
      }
    }
    function current() {
      if (settingsOpen) return setItems()[setIdx];
      if (fsOpen) return fsItems()[fsIdx];
      var r = rows()[row];
      return r && r[Math.min(idx[row], r.length - 1)];
    }
    return {
      current: current,
      index: function () { return setIdx; },
      refresh: function (i) {
        if (fsOpen && !settingsOpen) {
          if (typeof i === 'number') fsIdx = i;
          fsIdx = Math.max(0, Math.min(fsIdx, fsItems().length - 1));
        } else if (settingsOpen) {
          var n = setItems().length;
          if (typeof i === 'number') setIdx = i;
          setIdx = Math.max(0, Math.min(setIdx, n - 1));
        }
        paint();
      },
      move: function (dx, dy) {
        if (settingsOpen) {
          setIdx = Math.max(0, Math.min(setItems().length - 1, setIdx + dy));
        } else if (fsOpen) {
          fsIdx = Math.max(0, Math.min(fsItems().length - 1, fsIdx + dx));
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
        else if (el.getAttribute('data-act') === 'fullscreen') openFs();
        else if (el.getAttribute('data-app')) launchApp(el.getAttribute('data-app'));
        else if (el.getAttribute('data-act') === 'settings') openSettings();
        else playerAction(el.getAttribute('data-act'));
        break;
      }
      case K.BLUE:
        if (settingsOpen) closeSettings();
        else { if (fsOpen) closeFs(); openSettings(); }
        break;
      case K.BACK: case K.ESC:
        if (settingsOpen) closeSettings(); else if (fsOpen) closeFs(); else history.back();
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

  // ---------- Self-update ----------
  // The loader only waits 4s for GitHub, then opens the version it remembers. If a newer
  // commit exists, reload once so the TV doesn't stay a version behind.
  function checkForUpdate() {
    var b = document.querySelector('base');
    var m = b && b.href.match(/@([0-9a-f]{40})\//);
    if (!m) return;                                   // local dev or branch copy
    var current = m[1];
    fetch('https://api.github.com/repos/paytbidd/frame-launcher-probe/commits/main',
      { headers: { Accept: 'application/vnd.github.sha' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (sha) {
        sha = sha.trim();
        if (!/^[0-9a-f]{40}$/.test(sha) || sha === current) return;
        var tried = null;
        try { tried = sessionStorage.getItem('frameLauncher.reloadedFor'); } catch (e) {}
        if (tried === sha) return;                    // already reloaded once for this version
        try {
          sessionStorage.setItem('frameLauncher.reloadedFor', sha);
          localStorage.setItem('frameLauncher.sha', sha);
        } catch (e) {}
        toast('Updating launcher…');
        setTimeout(function () { location.reload(); }, 800);
      })
      .catch(function () { /* offline or rate-limited: keep running this version */ });
  }

  // ---------- Start ----------
  pingService();
  syncService();
  setTimeout(checkForUpdate, 3000);
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000);   // launcher may stay open for days
  tickClock();
  setInterval(tickClock, 5000);
  renderApps();
  checkInstalled();
  loadWeather();
  setInterval(loadWeather, 15 * 60 * 1000);
  pollStatus();
})();
