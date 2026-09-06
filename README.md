# Build on Comprehend

Comprehend is the ambient documentation platform physical therapists use to turn the visit into the note. **Apps** let your product run inside Comprehend, next to the note: you tell Comprehend what happened outside the room (home exercise, remote monitoring, force plates, outcomes) and Comprehend tells you what was said inside it.

- **Developer guide:** https://app.comprehendpt.com/developers/
- **Sandbox (no account needed):** https://app.comprehendpt.com/vendor-sandbox/ — a fake Comprehend around your real app, pointed at `localhost`
- **Examples:** [`vendor-examples/`](vendor-examples/) — a home-exercise / RTM app and a force-plate app that exercise the whole contract
- **The script:** `https://app.comprehendpt.com/comprehend.js` — load it from there, don't vendor a copy; it pins the host origin and evolves with the contract

This repo mirrors what `app.comprehendpt.com` serves so you can read it, diff it, and file issues. Source of truth lives in Comprehend's app repo; changes land here via `scripts/sync-vendor-sdk.sh`.

## The contract in one screen

```html
<script src="https://app.comprehendpt.com/comprehend.js"></script>
<script>
  // 1. REQUIRED — whenever a chart is open on YOUR side and on ours, tell us who and what.
  //    That call is also the link: we remember your id for this patient from then on.
  function sync() {
    const theirs = comprehend.patient;          // { id, name, dob, ref } | null — ref is YOUR id if linked before
    const mine = myApp.currentPatient;          // whatever chart the clinician has open in your UI
    if (!theirs || !mine) return;
    comprehend.provide(`## Home program — last 7 days
- Adherence: 5/7 sessions
- Pain trend: 6 → 3`,
      { patientId: theirs.id, patientName: mine.fullName, patientRef: mine.id });
  }
  comprehend.on('ready', sync);
  comprehend.on('patient', ({ patient }) => {   // clinician switched charts in Comprehend
    if (patient?.ref) myApp.openChart(patient.ref);      // linked before → open it, zero clicks
    sync();
  });
  myApp.on('chartOpened', sync);                // clinician switched charts in YOUR UI

  // 2. THE VALUE — subscribe to the encounter. We push answers when the clinician acts.
  comprehend.subscribe({
    rtm_mentioned: 'boolean — was remote monitoring discussed today?',
    hep_changes:   'string[] — exercises the PT added, removed, or modified',
    pain_now:      'number — pain the patient reported today, 0-10, or null',
  }, ({ patientId, answers }) => { /* update your UI for patientId */ });
</script>
```

Three surfaces (`provide`, `patient`, `subscribe`), two events (`ready`, `patient`). Calls made before the handshake are queued — nothing to gate on.

## Surface

| Call | Notes |
|---|---|
| `comprehend.provide(markdown, { patientId, patientName, patientRef })` | Replaces your buffer for that patient; it becomes context for the note, attributed to you. Markdown only, ≤ 8 KB. `patientId` is ours, `patientName` is the name of the patient open in *your* app (we check it resembles ours), `patientRef` is your id — handed back as `patient.ref` next visit. |
| `comprehend.patient` | `{ id, name, dob, ref }` or `null` when no chart is open. |
| `comprehend.subscribe(structure, onAnswers, onError?)` | Registers a question structure; returns `unsubscribe()`. Pushes `{ patientId, answers, contextVersion, answeredAt, partial?, errors? }`. ≤ 10 live subscriptions, ≤ 200 leaves each. |
| `comprehend.on('ready' \| 'patient', fn)` | `ready` once per load; `patient` on chart switch. Both carry `{ patient }`. |

### Structures

A structure is a nested object whose **shape is the answer shape**. Leaves are either shorthand strings — `'boolean — was RTM discussed?'` — or objects with any of `_type` (`boolean | number | string | string[] | number[]`), `_description`, `_choices`, `_existingValue`. Arrays with one prototype row are lists, sized to what the transcript supports.

```js
comprehend.subscribe({
  adherence_barrier: { _type: 'string', _choices: ['pain', 'time', 'confusion', 'none', 'unclear'], _description: 'main reason for missed sessions' },
  pain: { now: { _type: 'number', _description: 'pain today, 0-10, or null' } },
  hep_changes: [{
    exercise: { _description: 'exercise name as the PT said it' },
    action:   { _choices: ['added', 'removed', 'modified', 'kept'] },
    dosage:   { _description: 'sets x reps or time, if stated' },
  }],
}, ({ answers }) => {});
```

### Errors

| Code | Meaning |
|---|---|
| `PATIENT_MISMATCH` · `NOT_OPEN` | Your `provide` named a patient whose chart is no longer open. Dropped. |
| `PATIENT_MISMATCH` · `NAME_MISMATCH` | Your `patientName` doesn't resemble the name on our chart. Buffer *and* link rejected; the clinician sees both names. |
| `BAD_STRUCTURE` | Unknown `_type`, malformed leaf, or too large (`reason: 'TOO_LARGE'`). |
| `NO_ENCOUNTER`, `TOO_MANY_SUBSCRIPTIONS`, `NOT_REGISTERED`, `TIMEOUT` | As named. |

## Trust model

- **Clinician-initiated, always.** Answers are computed inside the clinician's session on their action (chart open, note generated, Refresh apps). Never on a timer, never from your servers.
- **Identity is the origin.** A clinic admin registers your exact origin; we accept messages only from it, from the frame we created. No tokens.
- **Linking is a human act.** The clinician opens the same patient in both places; your first `provide` is the link, and we check the names resemble each other.
- **BAA first.** A clinic admin cannot enable your app until they confirm their organization holds a signed BAA with you — and they are told exactly what they are sharing. Have yours ready.

## Going live with a clinic

The clinic admin registers your launch URL under *Admin Settings → Apps*, confirms the BAA, and enables it. Give clinicians a button: `https://app.comprehendpt.com/User/apps?add=<your https launch URL>` signs them in and pre-fills the form for their admin.

Requirements: your launch URL is `https` and framable by `https://app.comprehendpt.com` (`frame-ancestors`); we append `?comprehend=1`; handle `patient` being `null` and `ref` being absent.

## Running the sandbox and examples locally

The pages here use relative paths, so any static server works:

```bash
npx serve .            # then open http://localhost:3000/vendor-sandbox/
```

`comprehend.js` pins the Comprehend host origin; when the sandbox runs on `localhost` it tells the script to pin `localhost` instead (`?comprehend_host=`), which is the only origin the script will accept besides production.

Questions: partners@comprehendpt.ai
