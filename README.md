# Build on Comprehend

**Your app in the room. Your data in the EMR.**

Comprehend is the ambient AI that listens to the PT visit and writes the note inside the EMRs clinics already use (25+ of them). Bring your app in — as it is, your UI and your login, one script tag — and two things happen: what you know about the patient enters the note, attributed to you, in whatever EMR the clinic runs; and what happened in the room comes back to you, per patient, as the note is written — which exercises were performed, what was progressed or dropped, what the patient reported, the plan. RTM and HEP programs get documented the way billing needs along the way.

- **Developer guide:** https://app.comprehendpt.com/developers.html
- **Sandbox (no account needed):** https://app.comprehendpt.com/vendor-sandbox.html — a fake Comprehend around your real app, pointed at `localhost`, with a server-side check that both our origins can frame you
- **Examples:** [`vendor-examples/`](vendor-examples/) — a home-exercise / RTM app (per-patient subscriptions built from each patient's program) and a force-plate app
- **The script:** `https://app.comprehendpt.com/comprehend.js` — load it from there, don't vendor a copy; it pins the host origin and evolves with the contract

This repo mirrors what `app.comprehendpt.com` serves so you can read it, diff it, and file issues. Source of truth lives in Comprehend's app repo; changes land here via `scripts/sync-vendor-sdk.sh`. Getting listed in the directory: [CONTRIBUTING.md](CONTRIBUTING.md). **Using Claude Code or another coding agent?** Point it at this repo — [`AGENTS.md`](AGENTS.md) is written for it.

## The lifecycle

This is the whole integration, in order. Every example in this repo follows it.

1. **Boot.** Comprehend opens your launch URL in a frame (`?comprehend=1`). Your page loads `comprehend.js`. If the user needs to sign in, they do it here — inside the frame.
2. **We fire `patient`.** As soon as the script initialises, Comprehend sends the `patient` event with reason `ready`. **Guaranteed** — even if your script loaded late, and even when no chart is open (`patient` is `null`). Register the listener whenever you like; a late listener is called immediately with the current state.
3. **Load that patient in your platform.** Use `patient.yourId` (your id for them, if you've linked before), else `patient.name` / `patient.dob`. Not in your system? Offer to create them. Then open their chart in your UI. If `patient` is `null` (the visit has no patient yet), leave whatever your user has open alone — step 4 still applies to them.
4. **When your patient page has loaded, set context — always.** `comprehend.setContext(markdown, { id, name, dob })`: what you know about them, in a few lines of markdown, plus your id, name and DOB for them. Call it whether or not Comprehend has a patient on the visit. With one, that call is the link (next visit `yourId` arrives set). With none, Comprehend shows the clinician a one-click "Use <your app>'s patient for this visit"; when they click, the patient is found or created and you get `patient(changed)` with `yourId` set — run the same handler again. Nothing is assigned without that click. If the names don't look like the same person and DOBs can't settle it, Comprehend asks the clinician — in Comprehend — to confirm once; you then get a new `patient` event with `yourId` and run the same code again.
5. **Optionally subscribe.** `comprehend.subscribe(structure, callback)` — the shape you want back, built from this patient's own data. Comprehend answers when the clinician acts and pushes the result. `{}` gets you a plain-text summary instead.
6. **Do it again on every `patient` event** (`changed`, `refresh`): tear down the old subscription, find, open, set context, subscribe.

## The whole API

```js
// EVENTS — we tell you. One handler, three reasons.
comprehend.on('patient', (patient, { reason }) => { … });  // patient | null; reason 'ready' | 'changed' | 'refresh'
comprehend.on('error',   ({ code }) => { … });              // codes only — the clinician gets the details

// CONTENT — you tell us, on the patient handle we gave you.
comprehend.setContext(markdown, { id, name, dob });   // the ONE call: what you know about YOUR patient. Also the link. Works with no Comprehend patient on the visit (the clinician can pull yours in)
comprehend.clearContext();

// QUESTIONS — you ask once per patient; we answer when the clinician acts.
const unsubscribe = comprehend.subscribe(structure, (answers, patient, meta) => { … });

comprehend.patient;                           // the current handle, or null
```

## The example that matters

```html
<script src="https://app.comprehendpt.com/comprehend.js"></script>
<script>
  comprehend.on('patient', async function onPatient(patient, { reason }) {
    if (!patient) return;                                        // Comprehend has no chart open
    // patient = { id, name, dob, yourId, setContext(), clearContext() }

    // ---- your business logic ---------------------------------------------
    let mine = byId(patient.yourId) || byName(patient.name);     // who this is in YOUR system
    if (!mine) {
      // Not in your system yet — offer to create them from what Comprehend knows.
      mine = await offerToCreatePatient({ name: patient.name, dob: patient.dob });
      if (!mine) return;                                         // the clinician said no
    }

    openChart(mine);                                             // navigate your UI to this patient …

    onChartLoaded(mine, () => {                                  // … and once that page is up, tell Comprehend what you know.
      // This call is also the link — next visit, patient.yourId === mine.id.
      comprehend.setContext(`## Home program — last 7 days
  - Adherence: ${mine.adherence}
  - Pain trend: ${mine.painTrend}`, { id: mine.id, name: mine.fullName });

      askAboutTheVisit(mine);
    });
  });

  let unsubscribe;
  function askAboutTheVisit(mine) {
    if (unsubscribe) unsubscribe();                              // questions are per patient
    unsubscribe = comprehend.subscribe({
      performed: {                                               // nest as deep as you like
        _description: 'Only what was done or reviewed in the room today',   // context for a whole branch
        'Sit-to-stand': { _type: 'boolean' },                    // yes / no
        'Hip hinge':    { _type: 'boolean' },
      },
      pain_today: { _type: 'integer', _description: '0-10 as the patient reported it, or null' },
      symptoms:   { _choices: ['pain', 'stiffness', 'swelling', 'giving way'], _multiple: true },   // pick any
      plan:       { _choices: ['progress', 'hold', 'regress', 'discharge'] },                    // pick one
      changes: [{                                                // a list — one row per change the PT stated
        exercise: { _choices: mine.program },                    // from YOUR data — this is where answers get sharp
        dosage:   'sets x reps or time, if stated',              // a plain string is a free-text answer
      }],
      patient_said: 'what the patient said about doing the home program',
    }, (answers) => render(answers));
  }

  // Nothing specific to ask yet? Ask for nothing: an empty structure ({}, '' or null) returns ONE plain-text
  // summary of the visit as it relates to your app, given the context you set — a string, not an object.
  comprehend.subscribe({}, (summary) => show(summary));
</script>
```

`reason` tells you why you're hearing about the patient: `ready` (your frame just loaded), `changed` (the clinician switched charts), `refresh` (the clinician is about to generate a note or pressed *Refresh apps* — send your latest). Same handler every time. Calls made before the handshake are queued — nothing to gate on.

**Ready, without a ready event.** The first `patient` event fires exactly once per frame load, before anything else, with `reason: 'ready'` — *even when no chart is open* (`patient` is `null`). Register callbacks whenever you like: before the handshake, `subscribe` and handle calls queue and flush on ready; after it, a new `patient` listener is invoked immediately with the current state. Nothing can be missed.

**Your id comes back.** `patient.yourId` is the `id` you passed to `setContext` for that patient last time. It is stored on Comprehend's patient record, so it survives devices and sessions — short-circuit on `byId(patient.yourId)` before you look at `patient.name`.

## Surface

| Surface | Notes |
|---|---|
| `comprehend.on('patient', fn)` | `fn(patient, { reason })`. `patient` is a **handle** `{ id, name, dob, yourId }` or `null`. `yourId` is the `id` you passed to `setContext` for this patient before. Late listeners are called immediately with the current state. |
| `comprehend.on('error', fn)` | `fn({ code })`. Codes: `STALE_PATIENT`, `CONTEXT_REJECTED`, `BAD_STRUCTURE`, `TOO_MANY_SUBSCRIPTIONS`. Never names or reasons — those go to the clinician. |
| `comprehend.setContext(markdown, { id, name, dob })` | The one method. Call it whenever your patient page has loaded, with or without a Comprehend patient on the visit. Replaces your context for that patient (markdown, ≤ 8 KB). `{ id, name }` is *your* patient; `name` is required and must resemble the chart's name (content and link are rejected together if not). The handle carries our patient id for you; a handle from a chart the clinician has left is dropped with `STALE_PATIENT`. |
| `comprehend.clearContext()` | Withdraws your content; the link is kept. |
| `comprehend.subscribe(structure, fn)` | `fn(answers, patient, { version, partial, errors })` whenever we evaluate. Returns `unsubscribe()`. ≤ 10 live subscriptions, ≤ 200 leaves each. **Re-subscribe per patient** with structures built from that patient's data. |
| `comprehend.patient` | The current handle or `null`. |

### Structures

A structure is a nested object whose **shape is the answer shape**. A plain string leaf is a free-text question. An object leaf constrains the answer: `_type` (`boolean | integer | number | string`), `_choices` (add `_multiple: true` for pick-any), `_description` — which also works on a branch, once, for context; `_existingValue` hints a prior value. An array with one prototype row is a list, sized to what the transcript supports. Fill `_choices` from your own data — that's where the answers get sharp.

### When we answer

Only on clinician action: the clinician presses **Comprehend** (the note is generated) or a refresh. Subscribing does not answer; opening a chart does not answer. Never on a timer, never from your servers. Each of those also sends you `patient(refresh)`, so you can update your context first. A subscription is re-evaluated only when its structure, the visit, or the patient changed.

## Trust model

- **Clinician-initiated, always.** Answers are computed inside the clinician's session on their action.
- **Identity is the origin, plus the frame.** A clinic admin registers your exact origin; we accept messages only from it, and only from the frame we created for you. No tokens. Several apps may share an origin if their launch URLs differ.
- **Linking is a human act.** The clinician opens the same patient in both places; your first `setContext` is the link, and we check the names resemble each other. If they don't, you get `CONTEXT_REJECTED` and the clinician is told which two names disagreed.
- **BAA first.** A clinic admin cannot enable your app until they confirm their organization holds a signed BAA with you — and they're told exactly what they're sharing. Have yours ready.

## Going live with a clinic

The clinic admin pastes *any link to your app* under *Admin Settings → Apps*. Comprehend reads your **manifest**, shows them your name, description and BAA contact, checks that we can embed you, and they confirm the BAA and turn you on. Give clinicians a button: `https://app.comprehendpt.com/User/apps?add=<your https launch URL>` signs them in and does the lookup for their admin.

**The manifest** — host it at `https://<your origin>/.well-known/comprehend-app.json`. Every key is optional; without the file admins see your hostname as the name and the pasted link is used as-is. `launchUrl` must be on the same origin as the manifest (URLs may be relative to the manifest file); `color` is your brand colour (`#rrggbb`) for the app pill inside Comprehend. If you cannot serve `/.well-known/`, a pasted link ending in `.json` is read as the manifest, and admins can type a manifest URL under *Advanced*. The sandbox's *Check my app* shows exactly what admins will see. Filled-in examples for the two example apps are in [`vendor-examples/.well-known/`](vendor-examples/.well-known/) — with a note on why they sit there rather than at the root.

```json
{
  "name": "Your app",
  "launchUrl": "https://your-app.example/comprehend",
  "description": "One sentence a clinic admin understands.",
  "icon": "https://your-app.example/icon.svg",
  "color": "#0f766e",
  "docs": "https://your-app.example/comprehend",
  "baaContact": "privacy@your-app.example",
  "categories": ["hep", "rtm"]
}
```

**Design for 350 px wide first.** Most clinicians run Comprehend as the Chrome side panel beside their EMR, almost always at its minimum width — about 350 px, roughly 330 px for your page. Treat that as the normal case: single column, no horizontal scroll, controls that work at that width. The sandbox has a 350 px toggle.

Requirements: your launch URL is `https` and framable by both the web app and the Chrome extension side panel — `frame-ancestors https://app.comprehendpt.com chrome-extension://pjafhckheppfdbidlhoedddfgebmcmnc` (the sandbox's *Check my app* verifies both); we append `?comprehend=1`; handle `patient` being `null` and `yourId` being absent.

**Your login must work inside a frame on our origin.** Your session cookie is a third-party cookie there, so `SameSite=Lax` cookies are not sent and the app appears logged out. Mark the session cookie `SameSite=None; Secure; Partitioned` (CHIPS), or sign in via a popup (we allow popups). This is the one thing that bites first integrators.

## Running the sandbox and examples locally

The pages here use relative paths, so any static server works:

```bash
npx serve .            # then open http://localhost:3000/vendor-sandbox.html
```

`comprehend.js` pins the Comprehend host origin; when the sandbox runs on `localhost` it tells the script to pin `localhost` instead (`?comprehend_host=`), which — along with our dev site and our extension ids — is the only thing the script will accept besides production.

Questions: partners@comprehendpt.ai
