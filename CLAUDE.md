# Implementing a Comprehend app — notes for coding agents

You are adding a Comprehend integration to an existing web app (a PT vendor's product: home-exercise / RTM, sensors, outcomes, an EMR). Read this file, then [`README.md`](README.md). Everything you need is in this repo; there is no SDK to install and no backend to call.

## What you are building

A page on the vendor's own origin that Comprehend opens in an iframe next to the clinical note. It loads one script, listens for one event, and talks back through a patient handle. Comprehend never calls the vendor's servers.

```html
<script src="https://app.comprehendpt.com/comprehend.js"></script>
```

## The lifecycle — implement exactly this

1. **Boot.** Comprehend opens your launch URL in a frame with `?comprehend=1`. Your page loads the script above. If the user needs to sign in, let them — inside the frame (their session cookie must be `SameSite=None; Secure; Partitioned`, or use a popup login).
2. **We fire `patient`.** The moment the script initialises it says hello, and Comprehend answers with the `patient` event, reason `ready`. **This is guaranteed**, even if your script loaded late or the clinician has no chart open (then `patient` is `null`). Register the listener any time; a late listener is called immediately with the current state.
3. **Load the patient in your platform.** From the handle: `patient.yourId` (the id you gave us for this person last time, or null), `patient.name`, `patient.dob`. Find them (`byId(yourId) || byName(name)`); if they don't exist, offer to create them from what Comprehend knows. Then navigate your UI to that patient — open their chart.
4. **When your patient page has loaded, set context.** Call `patient.setContext(markdown, { id: yourPatientId, name: yourPatientName })` with a short markdown summary of what you know (adherence, test results, program). This call is also what links the two records; next visit `patient.yourId` arrives already set. Pass `dob` too when you have it. If the two records don't look like the same person (no prior link, DOBs don't match or aren't known, names don't resemble — "Robert" vs "Bob" counts), Comprehend rejects it and you get `error({ code: 'CONTEXT_REJECTED' })`. **The clinician resolves this in Comprehend's UI**, not yours: they see both names and can confirm "same patient" once; you then receive a fresh `patient` event with `yourId` set and simply run the same code path again. Don't build your own override.
5. **Optionally subscribe.** `const unsubscribe = comprehend.subscribe(structure, (answers, patient, meta) => …)` — declare the shape you want back, built from *this* patient's data (one `{ _type: 'boolean' }` per prescribed exercise, `_choices` from what you actually assigned). Comprehend answers only when the clinician acts — presses **Comprehend** to generate the note, or a refresh — and pushes to your callback. Subscribing does not answer; neither does opening a chart. Expect nothing until then, and show that state honestly in your UI. An empty structure (`{}`) returns one plain-text summary string instead.
6. **Repeat on every `patient` event.** Reasons: `ready` (frame loaded), `changed` (clinician switched charts), `refresh` (clinician is about to generate a note or pressed refresh — send your latest). Same code path each time: unsubscribe the previous subscription, find the patient, open, set context, subscribe.

Keep your page at its natural height (no fixed-height body with its own scroll); the script reports content height and Comprehend sizes the frame.

**Width: design for ~330 px first.** Clinicians overwhelmingly run Comprehend as the Chrome side panel beside their EMR at its minimum width (~350 px). Your page gets roughly 330 px. Single column, no horizontal scroll, nothing that only works on a desktop layout. Also make it look right full-width (the web app), but 330 px is the common case.

## Contract summary

| Surface | Detail |
|---|---|
| `comprehend.on('patient', fn)` | `fn(patient \| null, { reason })`. Handle: `{ id, name, dob, yourId, setContext(md, { id, name }), clearContext() }`. |
| `comprehend.on('error', fn)` | `fn({ code })` — `STALE_PATIENT`, `CONTEXT_REJECTED`, `BAD_STRUCTURE`, `TOO_MANY_SUBSCRIPTIONS`. Codes only; the clinician sees the details. |
| `comprehend.subscribe(structure, fn)` | Returns `unsubscribe()`. ≤ 10 live subscriptions, ≤ 200 leaves each. |
| Structure grammar | Nested object whose shape is the answer shape. Leaf: plain string (free text) or `{ _type: 'boolean' \| 'integer' \| 'number' \| 'string', _description, _choices, _multiple }`. `_description` also allowed on a branch. One-row array = list. `{}` = summary string. |
| Manifest | Host `https://<origin>/.well-known/comprehend-app.json`: `name, launchUrl, description, icon, color, docs, baaContact, categories`. URLs may be relative to the manifest. |
| Framing | `Content-Security-Policy: frame-ancestors https://app.comprehendpt.com chrome-extension://pjafhckheppfdbidlhoedddfgebmcmnc`. No `X-Frame-Options: DENY`. |

## How to test without a Comprehend account

Serve your page on `localhost`, open https://app.comprehendpt.com/vendor-sandbox.html, paste the URL, Load. The sandbox is a fake Comprehend with fake patients (Ann Kim, Bob Smith, Maria Lopez), canned encounters and mock answers; it logs every message across the frame. **Check my app** verifies your manifest and framing headers from Comprehend's server. Working references: [`vendor-examples/hep-rtm.html`](vendor-examples/hep-rtm.html) and [`vendor-examples/force-plate.html`](vendor-examples/force-plate.html) implement the full lifecycle, including the create-patient path.

## Do not

- Vendor a copy of `comprehend.js`; load it from `app.comprehendpt.com`.
- Poll, use timers, or expect answers on subscribe or on chart open — only the clinician's Comprehend / refresh answers.
- Send PHI anywhere but `setContext`; never log patient names from `error` events (there are none).
- Expect `patient.yourId` on the first visit, or `patient` to be non-null.
