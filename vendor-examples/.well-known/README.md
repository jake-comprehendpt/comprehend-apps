# The manifest, as the two examples would publish it

On **your** origin the file lives at exactly one place:

```
https://<your origin>/.well-known/comprehend-app.json
```

That is what a clinic admin's paste-a-link lookup fetches (`POST /v1/vendorApps/resolve`),
and what the sandbox's *Check my app* shows you. One origin, one app, one manifest.

The two example apps in this folder share Comprehend's own origin, so they can't each
own that path. Their manifests sit here instead, one per example, so you can see the
shape filled in with real values:

- [`hep-rtm.json`](hep-rtm.json) — for [`../hep-rtm.html`](../hep-rtm.html)
- [`force-plate.json`](force-plate.json) — for [`../force-plate.html`](../force-plate.html)

Copy one, rename it `comprehend-app.json`, put it at the root of your origin under
`/.well-known/`, and change the values. (If you cannot serve that path, the admin can paste a
link to the manifest itself, or type its URL under *Advanced* when adding your app — it still
has to live on your origin.) Rules the resolver enforces:

| key | rule |
|---|---|
| `name` | up to 80 characters; what admins see as the app's name |
| `launchUrl` | the page we open in the Apps tab; **same origin as the manifest**. Absolute `https`, or relative to the manifest (`../app.html`) |
| `description` | up to 200 characters, one sentence a clinic admin understands |
| `icon` | square, 64px or larger; `https` or relative to the manifest |
| `color` | brand colour as `#rrggbb`; used for the app's pill and accents inside Comprehend |
| `docs` | `https` URL of your Comprehend integration page |
| `baaContact` | e-mail or URL where a clinic gets your Business Associate Agreement |
| `categories` | up to 5 short tags, e.g. `hep`, `rtm`, `sensor`, `outcomes` |

Every key is optional. Without the file, admins see your hostname as the name and the
link they pasted is used as-is; the file is what turns that into a proper card. The whole
file must be under 16 KB and be served with a 200 (an HTML fallback page counts as
"no manifest"). CORS headers are not needed: Comprehend's server reads it, not the browser.
