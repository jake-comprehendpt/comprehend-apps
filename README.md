# Build on Comprehend

Comprehend is the ambient documentation platform physical therapists use to turn the visit into the note. **Apps** let your product run inside Comprehend, next to the note — in the web app and in the Chrome extension's side panel: you tell Comprehend what happened outside the room (home exercise, remote monitoring, force plates, outcomes) and Comprehend tells you what was said inside it.

- **Developer guide:** https://app.comprehendpt.com/developers.html
- **Sandbox (no account needed):** https://app.comprehendpt.com/vendor-sandbox.html — a fake Comprehend around your real app, pointed at `localhost`, with a server-side check that both our origins can frame you
- **Examples:** [`vendor-examples/`](vendor-examples/) — a home-exercise / RTM app (per-patient subscriptions built from each patient's program) and a force-plate app
- **The script:** `https://app.comprehendpt.com/comprehend.js` — load it from there, don't vendor a copy; it pins the host origin and evolves with the contract

This repo mirrors what `app.comprehendpt.com` serves so you can read it, diff it, and file issues. Source of truth lives in Comprehend's app repo; changes land here via `scripts/sync-vendor-sdk.sh`. Getting listed in the directory: [CONTRIBUTING.md](CONTRIBUTING.md).

## The whole API

```js
// EVENTS — we tell you. One handler, three reasons.
comprehend.on('patient', (patient, { reason }) => { … });  // patient | null; reason 'ready' | 'changed' | 'refresh'
comprehend.on('error',   ({ code }) => { … });              // codes only — the clinician gets the details

// CONTENT — you tell us, on the patient handle we gave you.
patient.setContext(markdown, { id, name });   // what you know about YOUR patient {id, name}. This is also the link.
patient.clearContext();

// QUESTIONS — you ask once per patient; we answer when the clinician acts.
const unsubscribe = comprehend.subscribe(structure, (answers, patient, meta) => { … });

comprehend.patient;                           // the current handle, or null
```

## The example that matters

```html
<script src="https://app.comprehendpt.com/comprehend.js"></script>
<script>
  let unsubscribe = null;

  comprehend.on('patient', (patient, { reason }) => {
    if (!patient) return;                                        // no chart open
    const mine = patient.yourId ? byId(patient.yourId) : findByName(patient.name);   // yourId = the id you gave us last time
    if (!mine) return;                                           // the clinician hasn't opened them in your app yet

    // CONTENT: what you know, and who you think this is. That call is the link.
    patient.setContext(`## Home program — last 7 days
- Adherence: ${mine.adherence}
- Program: ${mine.program.join(', ')}`, { id: mine.id, name: mine.fullName });

    // QUESTIONS: built from THIS patient's program, re-declared whenever the patient changes.
    if (unsubscribe) unsubscribe();
    const performed = Object.fromEntries(mine.program.map((ex) => [ex, `boolean — was "${ex}" performed or reviewed in today's visit?`]));
    unsubscribe = comprehend.subscribe({
      performed,                                                                 // { "Sit-to-stand": true, "Hip hinge": false, ... }
      changes: [{ exercise: { _choices: mine.program },
                  change:   { _choices: ['progressed', 'regressed', 'removed', 'kept'] },
                  dosage:   'string — sets x reps or time, if stated' }],
      adherence_report: 'string — what the patient said about doing the home program',
      pain_today:       'number — 0-10 as reported, or null',
    }, (answers, forPatient, meta) => render(forPatient.id, answers, meta.version));
  });
</script>
```

`reason` tells you why you're hearing about the patient: `ready` (your frame just loaded), `changed` (the clinician switched charts), `refresh` (the clinician is about to generate a note or pressed *Refresh apps* — send your latest). Same handler every time. Calls made before the handshake are queued — nothing to gate on.

**Ready, without a ready event.** The first `patient` event fires exactly once per frame load, before anything else, with `reason: 'ready'` — *even when no chart is open* (`patient` is `null`). Register callbacks whenever you like: before the handshake, `subscribe` and handle calls queue and flush on ready; after it, a new `patient` listener is invoked immediately with the current state. Nothing can be missed.

**Your id comes back.** `patient.yourId` is the `id` you passed to `setContext` for that patient last time. It is stored on Comprehend's patient record, so it survives devices and sessions — short-circuit on `byId(patient.yourId)` before you look at `patient.name`.

## Surface

| Surface | Notes |
|---|---|
| `comprehend.on('patient', fn)` | `fn(patient, { reason })`. `patient` is a **handle** `{ id, name, dob, yourId, setContext(), clearContext() }` or `null`. `yourId` is the `id` you passed to `setContext` for this patient before. Late listeners are called immediately with the current state. |
| `comprehend.on('error', fn)` | `fn({ code })`. Codes: `STALE_PATIENT`, `CONTEXT_REJECTED`, `BAD_STRUCTURE`, `TOO_MANY_SUBSCRIPTIONS`. Never names or reasons — those go to the clinician. |
| `patient.setContext(markdown, { id, name })` | Replaces your context for that patient (markdown, ≤ 8 KB). `{ id, name }` is *your* patient; `name` is required and must resemble the chart's name (content and link are rejected together if not). The handle carries our patient id for you; a handle from a chart the clinician has left is dropped with `STALE_PATIENT`. |
| `patient.clearContext()` | Withdraws your content; the link is kept. |
| `comprehend.subscribe(structure, fn)` | `fn(answers, patient, { version, partial, errors })` whenever we evaluate. Returns `unsubscribe()`. ≤ 10 live subscriptions, ≤ 200 leaves each. **Re-subscribe per patient** with structures built from that patient's data. |
| `comprehend.patient` | The current handle or `null`. |

### Structures

A structure is a nested object whose **shape is the answer shape**. Leaves are shorthand strings — `'boolean — was RTM discussed?'` — or objects with `_type` (`boolean | number | string | string[] | number[]`), `_description`, `_choices`, `_existingValue`. An array with one prototype row is a list, sized to what the transcript supports. Fill `_choices` from your own data — that's where the answers get sharp.

### When we answer

Only on clinician action: chart open, note generated, *Refresh apps*. Never on a timer, never from your servers. Each of those also sends you `patient(refresh)`, so you can update your context first. A subscription is re-evaluated only when its structure, the visit, or the patient changed.

## Trust model

- **Clinician-initiated, always.** Answers are computed inside the clinician's session on their action.
- **Identity is the origin.** A clinic admin registers your exact origin; we accept messages only from it, from the frame we created. No tokens.
- **Linking is a human act.** The clinician opens the same patient in both places; your first `setContext` is the link, and we check the names resemble each other. If they don't, you get `CONTEXT_REJECTED` and the clinician is told which two names disagreed.
- **BAA first.** A clinic admin cannot enable your app until they confirm their organization holds a signed BAA with you — and they're told exactly what they're sharing. Have yours ready.

## Going live with a clinic

The clinic admin registers your launch URL under *Admin Settings → Apps*, confirms the BAA, and enables it. Give clinicians a button: `https://app.comprehendpt.com/User/apps?add=<your https launch URL>` signs them in and pre-fills the form for their admin.

Requirements: your launch URL is `https` and framable by both the web app and the Chrome extension side panel — `frame-ancestors https://app.comprehendpt.com chrome-extension://pjafhckheppfdbidlhoedddfgebmcmnc` (the sandbox's *Check my headers* verifies both); we append `?comprehend=1`; handle `patient` being `null` and `yourId` being absent.

## Running the sandbox and examples locally

The pages here use relative paths, so any static server works:

```bash
npx serve .            # then open http://localhost:3000/vendor-sandbox.html
```

`comprehend.js` pins the Comprehend host origin; when the sandbox runs on `localhost` it tells the script to pin `localhost` instead (`?comprehend_host=`), which — along with our dev site and our extension ids — is the only thing the script will accept besides production.

Questions: partners@comprehendpt.ai
