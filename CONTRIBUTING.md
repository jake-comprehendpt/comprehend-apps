# Getting listed in the Comprehend partner directory

Listed apps show up as one-click "Register" cards in every clinic's **Admin Settings → Apps**, and on https://app.comprehendpt.com/developers.html#directory. Listing is a reviewed pull request against [`partners.json`](partners.json) in this repo.

## Before you open the PR

1. **Build** against the [sandbox](https://app.comprehendpt.com/vendor-sandbox.html) until `provide`, linking, and `subscribe` all behave.
2. **Pilot** with at least one clinic: their admin registers your launch URL directly, confirms their BAA with you, enables it, and you're live for that group. We'll ask who.
3. Have a **BAA template** ready to sign with clinics, and a public page that tells a clinic admin how to get it (that's your `docs` URL).

## The review checklist

We check every item; a PR that fails one gets a comment, not a merge.

- Loads `comprehend.js` from `https://app.comprehendpt.com/comprehend.js` — no vendored copy.
- Launch URL is `https`, on the declared `embedOrigin`, and framable by both the web app and the Chrome extension side panel — `frame-ancestors https://app.comprehendpt.com chrome-extension://pjafhckheppfdbidlhoedddfgebmcmnc`, no `X-Frame-Options: DENY`.
- Calls `provide` with `patientId`, `patientName`, and a stable `patientRef`; opens the linked chart when `patient.ref` is present; handles `patient` being `null`.
- Shows the Comprehend patient name next to your open chart so a mismatch is visible to the clinician.
- Declares subscriptions once (not on every render); each structure ≤ 200 leaves.
- Provides only what a clinician would want in the note; markdown ≤ 8 KB.

A listing means **Comprehend** reviewed those points. It never stands in for a clinic's BAA with you — every clinic confirms its own before enabling your app.

## The PR

Add one object to the `partners` array (see the `schema` block in the file):

```json
{
  "id": "acme-hep",
  "name": "Acme HEP",
  "category": "hep",
  "blurb": "Home-program adherence and pain trend, in the note.",
  "embedOrigin": "https://app.acme-hep.com",
  "launchUrl": "https://app.acme-hep.com/comprehend",
  "website": "https://acme-hep.com",
  "docs": "https://acme-hep.com/comprehend",
  "logo": "https://acme-hep.com/logo.svg",
  "verified": false,
  "listedAt": "2026-09-06"
}
```

Leave `verified: false`; we flip it when we merge. Keep `blurb` under 140 characters and write it for a clinician, not a buyer.

## Removal

We remove a listing if the app stops meeting the checklist, if the origin changes without a PR, or at your request. Clinics that already registered you are unaffected — their registration is theirs.
