# Permission Detective for Salesforce

**Chrome extension that answers "Why can't this user see this field?" in 2 seconds**

## Why I Built This

Salesforce admins routinely burn 15+ minutes hunting through 8 different Setup
tabs — Profiles, Permission Sets, Field-Level Security, Sharing Rules, Role
Hierarchy — just to answer one question: *why can't this specific user see or
edit this specific field on this specific record?*

Permission Detective collapses that entire investigation into one click. It
queries Salesforce's own `UserRecordAccess` API (the same access-evaluation
engine Salesforce itself uses internally) directly from the record page, and
shows the answer — plus exactly which Profile or Permission Set is
responsible for it — in seconds, not tab-switches.

## Features

- **On-page overlay** — opens right on the record you're already looking at, no context switching to Setup
- **`UserRecordAccess` API integration** — record-level Read/Edit/Delete/Transfer access, straight from Salesforce's own evaluation engine (which already factors in OWD, role hierarchy, sharing rules, manual sharing, and Apex sharing combined)
- **Names the specific sharing mechanism** — queries the object's own Share table (`AccountShare`, `MyObject__Share`, etc.), scoped to the user's role/group memberships, to say *which* sharing rule, manual share, team, or Apex sharing reason is actually responsible — not just a generic "blocked by sharing"
- **Visual permission chain** — traces User → Profile/Permission Sets → Object CRUD → Field-Level Security → Record Access, and shows exactly where the chain breaks
- **Field-level-aware verdict** — the top-line result reflects combined record + object + field access, so it can never say "granted" when a field's FLS actually denies Edit
- **Object-level-only mode** — Field API Name is optional; leave it blank to check just object- and record-level access without picking a specific field
- **Color-coded results** — green/red/yellow badges for granted, denied, and partial access, at a glance
- **Source attribution** — every grant or denial is tied to the specific Profile or Permission Set responsible for it, not just a yes/no
- **Search-as-you-type user picker** — find the target user by name/username/email instead of hand-copying an 18-character Id
- **Auto-resolves field API names** — click a field on the page and it resolves the real API name via Salesforce's Describe API
- **SLDS-styled UI** — matches Salesforce's own Lightning Design System, so it feels native to the platform
- **Zero external servers** — every API call goes straight from your browser to your own Salesforce org, using your existing session

## Screenshots

[Screenshots coming soon]

## Installation

**Chrome Web Store:** [Coming soon]

**Manual installation (Load unpacked):**

1. Clone this repo or download it as a ZIP and extract it
2. Open `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `permission-detective/` folder
5. Navigate to any Salesforce Lightning record page
6. Click the Permission Detective icon in your browser toolbar to open the panel

## Tech Stack

- **Manifest V3** (Chrome Extensions)
- **Vanilla JavaScript** — no frameworks, no build step required to run it
- **Salesforce REST API** (`UserRecordAccess`, `{Object}Share`, `GroupMember`, `FieldPermissions`, `ObjectPermissions`, `PermissionSetAssignment`, sObject Describe)
- **SLDS (Salesforce Lightning Design System)** — for a UI that feels native to Salesforce

## Roadmap

- **FieldScope mode** — analyze every field on an object at once, not one at a time
- **Bulk permission analyzer** — check one field/record across a list of users in one pass
- **Export to CSV** — export analysis results for audit documentation

## Author

**Shreyash Gaidhane**
Salesforce Solution Consultant

https://www.linkedin.com/in/shreyash-g-3b4143253/
---

## Architecture

```
permission-detective/
├── manifest.json        MV3 config: permissions, host_permissions, content script, background worker
├── background.js         Service worker — the only place that touches cookies/fetch (avoids CORS/CSP issues)
├── content.js             Injected into Salesforce pages — builds the overlay panel, detects the
│                          current record id / object api name from the URL, detects clicked fields
├── overlay.js             Renders SLDS-styled analysis results into the panel
├── overlay.css            SLDS-token styling for the panel
├── grant-access.html/.js  One-click runtime permission grant page (see "Runtime permissions" below)
├── build.js               Packaging script — minifies and zips the extension for Chrome Web Store upload
├── icons/                 Extension icons
└── README.md
```

### Data flow

1. **content.js** runs on `lightning.force.com` / `my.salesforce.com` pages, parses the
   current URL to detect the record id and object API name.
2. Clicking the extension's **toolbar icon** toggles the overlay panel open/closed
   (via `chrome.action.onClicked` in background.js — no floating button injected
   into the page until you actually ask for it).
3. The panel opens pre-filled with the detected record id/object. Click a field
   on the page to auto-resolve its API name, or type it manually. Search for the
   target user by name — the user whose access you're debugging, not necessarily
   the logged-in admin.
4. On **Analyze**, the panel sends a `chrome.runtime.sendMessage` request to
   **background.js** with `action: 'analyzePermissions'`.
5. **background.js** (the service worker) finds every plausible Salesforce
   session cookie for the org (trying `my.salesforce.com`, `salesforce.com`,
   and `lightning.force.com`, since a cookie can be genuinely present on one
   domain yet still get rejected by the API — the extension tries each
   candidate against the real API in turn rather than guessing), then fires
   parallel authenticated REST calls to `/services/data/v63.0/query`:
   - `UserRecordAccess` → record-level Read/Edit/Delete/Transfer + MaxAccessLevel
   - `{Object}Share` (e.g. `AccountShare`), scoped to the user's Id **and** every group/role/queue they belong to (via `GroupMember`) → names the specific sharing mechanism (`RowCause`: Owner, Rule, Team, Manual, Apex Managed Sharing, etc.) responsible for the record-level result above
   - `FieldPermissions`, filtered by both `SobjectType` and `Field` (not `Field` alone — Salesforce's `Field = 'Object.Field'` comparison isn't reliably scoped to one object on its own) — skipped entirely if no field was specified
   - `ObjectPermissions` (scoped to the user's assigned Permission Sets) → object CRUD per source
   - `PermissionSetAssignment` → the user's Profile + Permission Set names
   - sObject **Describe** → whether the target field is FLS-controllable at all (required standard fields never have FieldPermissions rows, and shouldn't be reported as "denied") — skipped when no field was specified
6. The service worker is used for all network calls specifically because
   content scripts run in the page's origin/CSP context and are more prone to
   CORS/CSP restrictions than the extension's own service worker.
7. Results are rendered as a breakdown grouped by Profile / Permission Set /
   sharing mechanism, plus a visual chain showing exactly where access is
   blocked, if it is. The top-line verdict (Granted/Partial/Denied) is
   computed once, combining record + object + field access, and both the
   summary badge and the chain read from that same computation — so they
   can never disagree with each other.

### Runtime permissions

Salesforce serves its Lightning UI from `*.lightning.force.com`, but the REST
API — and the session that authenticates it — lives on `*.my.salesforce.com`.
Because you rarely browse to that API domain directly, Chrome sometimes never
offers to grant the extension access to it through its normal Site Access UI.
`grant-access.html` is a small, one-time popup that requests that access
explicitly via `chrome.permissions.request()` (which requires a real user
gesture on an extension page — it can't be triggered from a service worker or
content script). It only appears if that access is genuinely missing, and the
grant persists afterward.

### Why a User Id input instead of "current user"?

This tool is meant for admins debugging *another* user's access ("why can't
Jane see the Amount field on this Opportunity?"), so the target `UserId` is a
required input rather than assumed to be the logged-in admin.

## Packaging for the Chrome Web Store

```
node build.js
```

Validates the manifest, builds a minified `dist/`, and zips it into
`permission-detective-v{version}.zip`, ready to upload. See `PUBLISHING.md`
for the full release process.

## Required Salesforce access

The logged-in Salesforce user (whose session is used to make the API calls)
needs:
- **API Enabled** on their profile
- Read access to `UserRecordAccess`, `FieldPermissions`, `ObjectPermissions`,
  `PermissionSetAssignment`, `GroupMember`, and the relevant object's own
  Share table (e.g. `AccountShare`) — available to System Administrators by
  default; other profiles may need "View Setup and Configuration" or
  equivalent. The sharing-mechanism attribution feature degrades gracefully
  (just shows less detail) rather than failing if any of these aren't
  accessible.

## Error handling

`background.js` distinguishes:
- **401** — session invalid for a given cookie → automatically retries with any other session cookie found before reporting failure
- **403** — insufficient API access → likely missing "API Enabled" on the profile
- **Network errors** — connectivity/DNS/etc., surfaced with the underlying message

All errors are logged to the service worker console (`chrome://extensions` →
"Inspect views: service worker") with the failing SOQL/URL for debugging.

## Privacy

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md). In short: no external servers, no
data collection, everything stays between your browser and your own
Salesforce org.
