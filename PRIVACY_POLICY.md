# Privacy Policy — Permission Detective for Salesforce

_Last updated: 2026-08-22_

## What this extension does

Permission Detective is a developer/admin diagnostic tool for Salesforce.
When you open it on a Salesforce record page and run an analysis, it queries
your own Salesforce org's REST API to explain why a specified user can or
cannot read/edit a specified field on that record.

## Data we access

- **Salesforce session cookie (`sid`)**: read locally, in your browser, to
  authenticate REST API calls to your own Salesforce org as you.
- **Data queried from your Salesforce org**: `UserRecordAccess`,
  `FieldPermissions`, `ObjectPermissions`, and `PermissionSetAssignment`
  records — i.e., permission/access metadata, not the business data on the
  record itself.
- **Page context**: the current URL, record id, and object API name, read
  from the Salesforce page you're viewing, to pre-fill the analysis form.

## Data we do NOT do

- We do **not** transmit any data to external servers. All API calls go
  directly from your browser (via the extension's background service
  worker) to your own Salesforce instance (`*.salesforce.com`,
  `*.my.salesforce.com`, `*.lightning.force.com`). No third-party server is
  involved at any point.
- We do **not** store, log, or persist personal data, session tokens, or
  query results outside of the current browser tab session. Nothing is
  written to `chrome.storage` beyond transient UI state, and nothing
  survives beyond the browser session unless you explicitly copy it
  yourself (e.g., via the "Copy Debug Info" button).
- We do **not** sell, share, or use your data for advertising, analytics,
  or any purpose other than displaying the permission analysis to you.
- We do **not** use remote code execution. All JavaScript executed by this
  extension ships inside the extension package; nothing is fetched and
  executed from a remote server at runtime.

## Permissions and why they're needed

| Permission | Reason |
|---|---|
| `activeTab` | Lets the extension act on the Salesforce tab you're currently viewing when you invoke it. |
| `cookies` | Reads the Salesforce session cookie (`sid`) so API calls can authenticate as you — no separate login/credential entry required. |
| `storage` | Reserved for lightweight UI state (e.g., last-used inputs); no personal or org data is persisted here. |
| `scripting` | Injects the overlay UI into the Salesforce page you're viewing. |
| `host_permissions` (`*.salesforce.com`, `*.my.salesforce.com`, `*.lightning.force.com`) | Required so the extension can run on your org's domain and call its REST API — Salesforce orgs are hosted on customer-specific subdomains of these patterns, so a wildcard is necessary to work across orgs. |

## Data retention

None. The extension holds analysis results only in memory, in the overlay
panel, for the duration of the browser tab. Closing the panel or navigating
away clears it. Nothing is transmitted or retained by us because there is no
"us" in the data path — the extension talks only to your own Salesforce org.

## Changes to this policy

If this extension's data practices change, this file will be updated and the
version history will reflect it via the extension's changelog/version
number.

## Contact

For questions about this extension's data practices, contact the developer
listed on its Chrome Web Store listing page.
