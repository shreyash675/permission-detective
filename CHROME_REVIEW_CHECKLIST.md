# Chrome Web Store Review Checklist — Permission Detective

Notes to have ready for the Chrome Web Store review team (and for the
"justification" fields in the Developer Dashboard listing form).

## 1. Why broad host permissions (`*.salesforce.com`, etc.) are needed

```
"host_permissions": [
  "https://*.lightning.force.com/*",
  "https://*.my.salesforce.com/*",
  "https://*.salesforce.com/*"
]
```

- Every Salesforce customer org lives on its own subdomain (e.g.
  `acme.my.salesforce.com`, `acme.lightning.force.com`) — there is no fixed,
  enumerable list of domains, so a wildcard on the Salesforce-owned base
  domains is the narrowest permission that still lets the extension work
  across arbitrary customer orgs.
- The pattern is scoped to Salesforce's own domains only — it does not
  request `<all_urls>` or access to any non-Salesforce site.
- Both the Lightning UI (`lightning.force.com`) and REST API host
  (`my.salesforce.com` / `salesforce.com`) are needed: the content script
  runs on the Lightning UI domain, while API calls made from the service
  worker target the instance's API domain, which can differ from the UI
  domain.

## 2. Why cookie access is needed

- Salesforce Lightning pages authenticate the logged-in user via a session
  cookie named `sid`. Reading this cookie (via `chrome.cookies.get`, scoped
  to the current Salesforce origin) lets the extension call the Salesforce
  REST API **as the already-logged-in user**, with no separate login flow,
  no credential entry, and no token handling outside what Salesforce itself
  already issued to the browser.
- The cookie value is used only in the `Authorization: Bearer` header of
  requests sent directly to that same Salesforce org's REST API. It is never
  transmitted anywhere else, logged, or persisted.

## 3. Justification for `activeTab` and `scripting`

- `activeTab`: grants access only to the tab the user is actively
  interacting with when they invoke the extension — the minimal-privilege
  alternative to a permanent all-tabs permission.
- `scripting`: used to inject the overlay UI (trigger button + analysis
  panel) into the Salesforce record page currently open, so the admin can
  view results in context without leaving the page.

## 4. No remote code execution (Manifest V3 requirement)

- All JavaScript (`background.js`, `content.js`, `overlay.js`) ships inside
  the extension package and is reviewed as part of the submission. Nothing
  is `eval()`'d, and no `<script src="https://...">` or dynamic `import()`
  from a remote origin is used anywhere in the codebase.
- The only network calls the extension makes are `fetch()` requests to the
  Salesforce REST API (`/services/data/v63.0/query`) on the same org the
  user is already authenticated to — these return JSON data, never
  executable code.
- The service worker (`background.js`) is the sole place `fetch` is called,
  consistent with MV3's requirement that host network access be centralized
  and auditable.

## Pre-submission checklist

- [ ] `manifest.json` has no `update_url` (Chrome Web Store assigns and
      manages this — a manifest with `update_url` set will be rejected).
- [ ] Icons present at 16/48/128px, referenced correctly in `manifest.json`.
- [ ] `PRIVACY_POLICY.md` content is published at a stable, publicly
      reachable URL and linked in the Developer Dashboard listing.
- [ ] Store listing description does not overstate functionality (this
      extension reads permission metadata; it does not modify permissions).
- [ ] Screenshots (see `STORE_LISTING.md`) accurately represent the current
      UI — review will reject listings with stale/misleading screenshots.
- [ ] `node build.js` run with no manifest validation warnings.
- [ ] Tested against a real Salesforce sandbox/dev org immediately before
      submission (see `PUBLISHING.md`).
