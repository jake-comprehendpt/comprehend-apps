/* comprehend.js — the bridge between your app and Comprehend.
 *
 * Served at https://app.comprehendpt.com/comprehend.js. No build step, no
 * dependencies, one global. Full contract: https://app.comprehendpt.com/developers.html
 *
 *   EVENTS (we → you)
 *   comprehend.on('patient', (patient, { reason }) => …)   // patient | null; reason 'ready' | 'changed' | 'refresh'
 *   comprehend.on('error',   ({ code }) => …)              // STALE_PATIENT | CONTEXT_REJECTED | BAD_STRUCTURE | TOO_MANY_SUBSCRIPTIONS
 *
 *   CONTENT (you → us, on the patient handle)
 *   patient.setContext(markdown, { id, name })             // what you know about YOUR patient {id, name}; this is also the link
 *   patient.clearContext()
 *
 *   QUESTIONS (you ask, we answer when the clinician acts)
 *   comprehend.subscribe(structure, (answers, patient, meta) => …)  // → unsubscribe()
 *
 *   comprehend.patient                                     // the current handle, or null
 *
 * A handle is your proof of which chart you were answering for: if the
 * clinician has moved on, calls on it are dropped with STALE_PATIENT. Calls
 * made before the handshake are queued — nothing to gate on.
 */
(function (global) {
  'use strict';
  if (global.comprehend) return;

  var HOST_ORIGIN = 'https://app.comprehendpt.com';
  // The host tells us where it lives when it isn't the production web app:
  // our dev site, a localhost sandbox, or the Comprehend Chrome extension's
  // side panel (an explicit allowlist of OUR extension ids — never any
  // chrome-extension://, or another extension could pose as Comprehend to
  // your page). Anything else is ignored and we keep pinning production.
  var EXTENSION_HOSTS = [
    'chrome-extension://pjafhckheppfdbidlhoedddfgebmcmnc' // Comprehend EMR Integration (desktop, Chrome Web Store)
  ];
  var qs = new URLSearchParams(global.location.search);
  var altHost = qs.get('comprehend_host');
  if (
    altHost &&
    (/^(https:\/\/dev\.comprehendpt\.com|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(altHost) ||
      EXTENSION_HOSTS.indexOf(altHost) !== -1)
  ) {
    HOST_ORIGIN = altHost;
  }

  var MAX_SUBSCRIPTIONS = 10;
  var MAX_LEAVES = 200;
  var MAX_BYTES = 32 * 1024;
  var TYPES = ['boolean', 'number', 'integer', 'string', 'string[]', 'number[]'];
  var LEAF_KEYS = ['_type', '_description', '_choices', '_existingValue', '_multiple'];

  var ready = false;
  var current = null;        // the current patient handle, or null
  var contextVersion = 0;
  var listeners = { patient: [], error: [] };
  var outbox = [];           // messages queued until the host says hello
  var subs = {};             // subscription id -> callback
  var seq = 0;

  function post(msg) {
    if (!ready) { outbox.push(msg); return; }
    global.parent.postMessage(msg, HOST_ORIGIN);
  }

  function emit(event, a, b) {
    listeners[event].slice().forEach(function (fn) {
      try { fn(a, b); } catch (e) { console.error('[comprehend] ' + event + ' listener threw', e); }
    });
  }

  function raise(code, message) {
    var err = new Error('[comprehend] ' + (message || code));
    err.code = code;
    return err;
  }

  // ---- patient handles -----------------------------------------------------
  // Built from what the host sends. `id` is Comprehend's; `yourId` is the id
  // you gave us for this patient before (or null). Methods carry `id` on the
  // wire so the host can drop anything meant for a chart that's no longer open.
  function makeHandle(p) {
    if (!p) return null;
    var handle = {
      id: String(p.id),
      name: p.name || '',
      dob: p.dob || null,
      yourId: p.ref != null ? String(p.ref) : null,
      setContext: function (markdown, you) {
        if (typeof markdown !== 'string') throw raise('BAD_CONTEXT', 'setContext(markdown, { id, name }) — markdown must be a string');
        var yourName = you && you.name;
        if (yourName && typeof yourName === 'object') yourName = [yourName.first, yourName.last].filter(Boolean).join(' ');
        if (typeof yourName !== 'string' || !yourName.trim()) {
          throw raise('BAD_CONTEXT', 'setContext(markdown, { id, name }) — name is the name of the patient open in YOUR app');
        }
        post({
          type: 'comprehend:context',
          patientId: handle.id,
          markdown: markdown,
          yourId: you && you.id != null ? String(you.id) : null,
          name: yourName.trim()
        });
      },
      clearContext: function () {
        post({ type: 'comprehend:clearContext', patientId: handle.id });
      }
    };
    return handle;
  }

  global.addEventListener('message', function (event) {
    if (event.origin !== HOST_ORIGIN || event.source !== global.parent) return;
    var msg = event.data;
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('comprehend:') !== 0) return;

    switch (msg.type) {
      case 'comprehend:patient': {
        var wasReady = ready;
        current = makeHandle(msg.patient);
        contextVersion = msg.contextVersion || 0;
        if (!wasReady) {
          ready = true;
          // Automatic ack: proves the script loaded and origin pinning matched, even
          // if your app has nothing to say yet. The host uses it for diagnostics only.
          post({ type: 'comprehend:ack', version: 3, href: String((global.location && global.location.href) || '').split('?')[0] });
          outbox.splice(0).forEach(post);
        }
        emit('patient', current, { reason: msg.reason || (wasReady ? 'changed' : 'ready') });
        break;
      }
      case 'comprehend:answers': {
        var cb = subs[msg.id];
        if (!cb) return;
        contextVersion = msg.contextVersion || contextVersion;
        var forPatient = current && current.id === String(msg.patientId) ? current : makeHandle({ id: msg.patientId });
        try {
          cb(msg.answers, forPatient, { version: msg.contextVersion, partial: !!msg.partial, errors: msg.errors || [] });
        } catch (e) { console.error('[comprehend] subscribe callback threw', e); }
        break;
      }
      case 'comprehend:error':
        emit('error', { code: msg.code, subscriptionId: msg.id || null });
        break;
    }
  });

  // ---- structure validation (mirrors the host's caps) -----------------------
  //   leaf   = 'type — prompt' | { _type?, _description?, _choices?, _existingValue? }
  //   object = { key: leaf | object | list }
  //   list   = [ row, ... ]  (first row is the prototype)
  function isEmptyStructure(s) {
    if (s == null) return true;
    if (typeof s === 'string') return !s.trim();
    return typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length === 0;
  }

  function validateStructure(structure) {
    var leaves = 0;
    function isLeafObject(v) {
      var keys = Object.keys(v);
      return keys.length > 0 && keys.every(function (k) { return k.charAt(0) === '_'; });
    }
    function walk(node, path) {
      if (typeof node === 'string') {
        if (!node.trim()) return 'empty prompt at "' + path + '"';
        var m = node.match(/^\s*([a-z\[\]]+)\s+[—–-]\s/);
        if (m && TYPES.indexOf(m[1]) === -1) return 'unknown type "' + m[1] + '" at "' + path + '"';
        leaves++;
        return null;
      }
      if (Array.isArray(node)) {
        if (node.length === 0) return 'empty list at "' + path + '" — give one prototype row';
        for (var i = 0; i < node.length; i++) {
          if (!node[i] || typeof node[i] !== 'object' || Array.isArray(node[i])) return 'list rows must be objects at "' + path + '[' + i + ']"';
          var rowProblem = walk(node[i], path + '[' + i + ']');
          if (rowProblem) return rowProblem;
        }
        return null;
      }
      if (!node || typeof node !== 'object') return 'unexpected value at "' + path + '"';
      if (isLeafObject(node)) {
        var keys = Object.keys(node);
        for (var k = 0; k < keys.length; k++) {
          if (LEAF_KEYS.indexOf(keys[k]) === -1) return 'unknown leaf key "' + keys[k] + '" at "' + path + '"';
        }
        if (node._type != null && TYPES.indexOf(node._type) === -1) return 'unknown _type "' + node._type + '" at "' + path + '"';
        if (node._choices != null && !Array.isArray(node._choices)) return '_choices must be an array at "' + path + '"';
        if (node._multiple != null && (typeof node._multiple !== 'boolean' || !node._choices)) return '_multiple must be true/false and needs _choices at "' + path + '"';
        leaves++;
        return null;
      }
      var childKeys = Object.keys(node);
      if (childKeys.length === 0) return 'empty object at "' + path + '"';
      for (var c = 0; c < childKeys.length; c++) {
        var key = childKeys[c];
        if (key === '_existingValue') continue; // row-level marker on a list row
        if (key === '_description') {             // branch-level context: allowed, must be a string, not a leaf
          if (typeof node[key] !== 'string') return '_description on a branch must be a string at "' + path + '"';
          continue;
        }
        if (key.charAt(0) === '_') return 'unknown key "' + key + '" on a branch at "' + path + '"';
        var problem = walk(node[key], path ? path + '.' + key : key);
        if (problem) return problem;
      }
      return null;
    }
    if (!structure || typeof structure !== 'object' || Array.isArray(structure)) return { problem: 'subscribe() takes a structure object', reason: 'MALFORMED' };
    var problem = walk(structure, '');
    if (problem) return { problem: problem, reason: 'MALFORMED' };
    if (leaves > MAX_LEAVES) return { problem: leaves + ' leaves; max ' + MAX_LEAVES + ' — split into several subscriptions', reason: 'TOO_LARGE' };
    var bytes;
    try { bytes = JSON.stringify(structure).length; } catch (e) { return { problem: 'structure is not serializable', reason: 'MALFORMED' }; }
    if (bytes > MAX_BYTES) return { problem: bytes + ' bytes; max ' + MAX_BYTES + ' — split into several subscriptions', reason: 'TOO_LARGE' };
    return null;
  }

  var comprehend = {
    get ready() { return ready; },
    get patient() { return current; },
    get contextVersion() { return contextVersion; },

    on: function (event, fn) {
      if (!listeners[event]) throw raise('BAD_EVENT', 'unknown event "' + event + '" (patient | error)');
      listeners[event].push(fn);
      // Late subscribers to 'patient' get the current state immediately.
      if (event === 'patient' && ready) { try { fn(current, { reason: 'ready' }); } catch (e) { console.error('[comprehend] patient listener threw', e); } }
      return function off() {
        var i = listeners[event].indexOf(fn);
        if (i !== -1) listeners[event].splice(i, 1);
      };
    },

    subscribe: function (structure, onAnswers) {
      if (typeof onAnswers !== 'function') throw raise('BAD_SUBSCRIBE', 'subscribe(structure, (answers, patient, meta) => …)');
      // Nothing to ask? Send nothing: '' / null / {} → the answer is one plain-text
      // summary of the visit as it relates to your app (a string, not an object).
      if (isEmptyStructure(structure)) structure = {};
      var invalid = structure && Object.keys(structure).length === 0 ? null : validateStructure(structure);
      if (invalid) { var e = raise('BAD_STRUCTURE', invalid.problem); e.reason = invalid.reason; throw e; }
      if (Object.keys(subs).length >= MAX_SUBSCRIPTIONS) throw raise('TOO_MANY_SUBSCRIPTIONS', 'max ' + MAX_SUBSCRIPTIONS + ' live subscriptions per app');
      var id = 'sub_' + (++seq) + '_' + Date.now().toString(36);
      subs[id] = onAnswers;
      post({ type: 'comprehend:subscribe', id: id, structure: structure });
      return function unsubscribe() {
        if (!subs[id]) return;
        delete subs[id];
        post({ type: 'comprehend:unsubscribe', id: id });
      };
    }
  };

  global.comprehend = comprehend;

  // Say hello. The host answers with comprehend:patient (reason 'ready'), so the
  // first patient event arrives whether this script ran before the frame's load
  // event, was injected later by a framework, or the page is a slow SPA. Sent
  // directly — the outbox only opens once that first patient message lands.
  try { global.parent.postMessage({ type: 'comprehend:hello', version: 3 }, HOST_ORIGIN); } catch (e) { /* not framed */ }
})(window);
