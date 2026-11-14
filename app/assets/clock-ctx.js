/* =============================================================================
   Morty's Auto Parts -- where a clock punch comes from
   Used by the time clock, the shift banner and My time. Each punch sends
   body.ctx: this browser's device id (a random id kept in localStorage, so the
   punch log can tell devices apart), the name someone gave the device, the
   device's clock and time zone, and its location when the time clock asks for
   it (Settings: off / ask / required away from the shop). The server adds the
   IP address, the browser and the till station.
   ============================================================================= */
(function () {
  'use strict';
  if (window.VisionClockCtx) return;
  function deviceId() {
    try {
      var id = localStorage.getItem('vision.deviceId');
      if (!id) {
        id = window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        localStorage.setItem('vision.deviceId', id);
      }
      return id;
    } catch (_) { return null; }
  }
  function deviceName() { try { return localStorage.getItem('vision.deviceName') || ''; } catch (_) { return ''; } }
  function setDeviceName(n) { try { localStorage.setItem('vision.deviceName', String(n || '').trim().slice(0, 60)); } catch (_) {} }
  var cfg = null;
  function config() {
    if (cfg) return Promise.resolve(cfg);
    return fetch('/api/clock/kiosk', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) { cfg = j; return j; }).catch(function () { return { location: 'ask' }; });
  }
  // The device's position, or why there is none. Never waits more than ~9 s.
  function where() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation || !window.isSecureContext) return resolve({ loc_status: 'unavailable' });
      var done = false, finish = function (v) { if (!done) { done = true; resolve(v); } };
      setTimeout(function () { finish({ loc_status: 'unavailable' }); }, 9000);
      navigator.geolocation.getCurrentPosition(function (p) { finish({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }); },
        function (e) { finish({ loc_status: e.code === 1 ? 'denied' : 'unavailable' }); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    });
  }
  function get() {
    return config().then(function (c) {
      var base = { device_id: deviceId(), device_name: deviceName(), client_time: new Date().toISOString(), tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || '') };
      if (c.location === 'off') return base;
      return where().then(function (l) { return Object.assign(base, l); });
    });
  }
  function stationKey() { try { return localStorage.getItem('vision.stationKey') || ''; } catch (_) { return ''; } }
  window.VisionClockCtx = { get: get, deviceId: deviceId, deviceName: deviceName, setDeviceName: setDeviceName, stationKey: stationKey };
})();
