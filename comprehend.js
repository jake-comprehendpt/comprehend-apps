/* comprehend.js — vendor-side bridge for Comprehend Apps.
 *
 * Served at https://app.comprehendpt.com/comprehend.js. Contract:
 * docs/vendor-apps-contract.md. No build step, no dependencies, one global.
 *
 *   comprehend.provide(markdown, { patientId, patientName, patientRef })  // keep the buffer current; id + name required
 *   comprehend.patient                                        // { id, name, dob, ref } | null
 *   comprehend.subscribe(structure, onAnswers, onError?)      // Flex++ structure; shorthand leaf 'type — prompt'
 *                                                             // onAnswers({ patientId, answers, contextVersion, answeredAt, partial?, errors? })
 *                                                             // -> unsubscribe()
 *   comprehend.on('ready' | 'patient', fn)
 *
 * Calls made before the host says hello are queued and flushed, so nothing
 * needs to be gated on `ready`.
 */
(function (global) {
  'use strict';
  if (global.comprehend) return;

  var HOST_ORIGIN = 'https://app.comprehendpt.com';
  // The host tells us where it lives when it isn't the production web app:
  // our dev site, a localhost Dev Console / sandbox, or the Comprehend Chrome
  // extension's side panel (an explicit allowlist of OUR extension ids — never
  // any chrome-extension://, or another extension could pose as Comprehend to
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
  var TYPES = ['boolean', 'number', 'string', 'string[]', 'number[]'];
  var LEAF_KEYS = ['_type', '_description', '_choices', '_existingValue'];

  var ready = false;
  var appId = null;
  var patient = null;
  var contextVersion = 0;
  var listeners = { ready: [], patient: [] };
  var outbox = [];          // messages queued until the host says hello
  var subs = {};            // subscription id -> { onAnswers, onError }
  var seq = 0;

  function post(msg) {
    if (!ready) { outbox.push(msg); return; }
    global.parent.postMessage(msg, HOST_ORIGIN);
  }

  function emit(event, payload) {
    listeners[event].slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[comprehend] listener threw', e); }
    });
  }

  function makeError(code, message, reason) {
    var err = new Error('[comprehend] ' + (message || code));
    err.code = code;
    if (reason) err.reason = reason;
    return err;
  }

  global.addEventListener('message', function (event) {
    if (event.origin !== HOST_ORIGIN || event.source !== global.parent) return;
    var msg = event.data;
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('comprehend:') !== 0) return;

    switch (msg.type) {
      case 'comprehend:ready':
        appId = msg.appId;
        patient = msg.patient || null;
        contextVersion = msg.contextVersion || 0;
        ready = true;
        outbox.splice(0).forEach(post);
        emit('ready', { appId: appId, patient: patient });
        break;

      case 'comprehend:patient':
        patient = msg.patient || null;
        contextVersion = msg.contextVersion || 0;
        emit('patient', { patient: patient });
        break;

      case 'comprehend:answers': {
        var sub = subs[msg.id];
        if (!sub) return;
        contextVersion = msg.contextVersion || contextVersion;
        try {
          sub.onAnswers({
            patientId: msg.patientId,
            answers: msg.answers,
            contextVersion: msg.contextVersion,
            answeredAt: msg.answeredAt,
            partial: !!msg.partial,
            errors: msg.errors || [],
          });
        } catch (e) { console.error('[comprehend] onAnswers threw', e); }
        break;
      }

      case 'comprehend:error': {
        var err = makeError(msg.code, msg.message, msg.reason);
        var target = msg.id && subs[msg.id];
        if (target && target.onError) {
          try { target.onError(err); } catch (e) { console.error('[comprehend] onError threw', e); }
        } else {
          console.warn(err.message);
        }
        break;
      }
    }
  });

  // A Flex++ Structure: nested object whose shape is the answer shape.
  //   leaf   = 'type — prompt' | { _type?, _description?, _choices?, _existingValue? }
  //   object = { key: leaf | object | list }
  //   list   = [ row, ... ]  where row is an object (first row is the prototype)
  // Returns { problem, reason } or null. Counts leaves so the host cap is
  // enforced before anything crosses the frame.
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
          if (!node[i] || typeof node[i] !== 'object' || Array.isArray(node[i])) {
            return 'list rows must be objects at "' + path + '[' + i + ']"';
          }
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
        leaves++;
        return null;
      }

      var childKeys = Object.keys(node);
      if (childKeys.length === 0) return 'empty object at "' + path + '"';
      for (var c = 0; c < childKeys.length; c++) {
        var key = childKeys[c];
        // Row-level _existingValue on a list row marks "update, don't re-add".
        if (key === '_existingValue') continue;
        var problem = walk(node[key], path ? path + '.' + key : key);
        if (problem) return problem;
      }
      return null;
    }

    if (!structure || typeof structure !== 'object' || Array.isArray(structure)) {
      return { problem: 'subscribe() takes a Flex++ structure object', reason: 'MALFORMED' };
    }
    var problem = walk(structure, '');
    if (problem) return { problem: problem, reason: 'MALFORMED' };
    if (leaves > MAX_LEAVES) {
      return { problem: leaves + ' leaves; max ' + MAX_LEAVES + ' — split into several subscriptions', reason: 'TOO_LARGE' };
    }
    var bytes;
    try { bytes = JSON.stringify(structure).length; } catch (e) { return { problem: 'structure is not serializable', reason: 'MALFORMED' }; }
    if (bytes > MAX_BYTES) {
      return { problem: bytes + ' bytes; max ' + MAX_BYTES + ' — split into several subscriptions', reason: 'TOO_LARGE' };
    }
    return null;
  }

  var comprehend = {
    get ready() { return ready; },
    get patient() { return patient; },
    get contextVersion() { return contextVersion; },

    on: function (event, fn) {
      if (!listeners[event]) throw makeError('BAD_EVENT', 'unknown event "' + event + '"');
      listeners[event].push(fn);
      if (event === 'ready' && ready) fn({ appId: appId, patient: patient });
      return function off() {
        var i = listeners[event].indexOf(fn);
        if (i !== -1) listeners[event].splice(i, 1);
      };
    },

    // patientId and patientName are required on purpose. patientId lets the
    // host drop a provide for a patient whose chart is no longer open;
    // patientName (the vendor's own name for the patient) lets the host
    // refuse a provide — and the link — when the two names don't resemble
    // each other (PATIENT_MISMATCH / NAME_MISMATCH).
    provide: function (markdown, opts) {
      if (typeof markdown !== 'string') throw makeError('BAD_PROVIDE', 'provide() takes a markdown string');
      var patientId = opts && opts.patientId;
      if (patientId == null || patientId === '') {
        throw makeError('BAD_PROVIDE', 'provide() requires { patientId } — use comprehend.patient.id');
      }
      var name = opts.patientName;
      if (name && typeof name === 'object') {
        name = [name.first, name.last].filter(Boolean).join(' ');
      }
      if (typeof name !== 'string' || !name.trim()) {
        throw makeError('BAD_PROVIDE', 'provide() requires { patientName } — the name of the patient open in YOUR app');
      }
      post({
        type: 'comprehend:provide',
        markdown: markdown,
        patientId: String(patientId),
        patientName: name.trim(),
        patientRef: opts.patientRef != null ? String(opts.patientRef) : null,
      });
    },

    subscribe: function (structure, onAnswers, onError) {
      if (typeof onAnswers !== 'function') throw makeError('BAD_SUBSCRIBE', 'subscribe() needs an onAnswers callback');
      var invalid = validateStructure(structure);
      if (invalid) throw makeError('BAD_STRUCTURE', invalid.problem, invalid.reason);
      if (Object.keys(subs).length >= MAX_SUBSCRIPTIONS) {
        throw makeError('TOO_MANY_SUBSCRIPTIONS', 'max ' + MAX_SUBSCRIPTIONS + ' live subscriptions per app');
      }
      var id = 'sub_' + (++seq) + '_' + Date.now().toString(36);
      subs[id] = { onAnswers: onAnswers, onError: typeof onError === 'function' ? onError : null };
      post({ type: 'comprehend:subscribe', id: id, structure: structure });
      return function unsubscribe() {
        if (!subs[id]) return;
        delete subs[id];
        post({ type: 'comprehend:unsubscribe', id: id });
      };
    },
  };

  global.comprehend = comprehend;
})(window);
