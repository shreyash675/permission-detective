# Publishing Guide — Permission Detective

## 1. Load the unpacked extension (Developer Mode)

1. Open `chrome://extensions/`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select the `permission-detective/` project folder (the one containing
   `manifest.json` — not `dist/`).
5. Confirm it loads with no errors and the correct icon/name appear in the
   extensions list.
6. After any source edit, click the reload icon (⟳) on the extension's card
   to pick up changes — content scripts also require reloading the
   Salesforce tab itself.

## 2. Test on a Salesforce org

1. Log in to a Salesforce **sandbox or Developer Edition org** (don't test
   against production first).
2. Navigate to any record's Lightning detail page
   (`https://<org>.lightning.force.com/lightning/r/<Object>/<Id>/view`).
3. Confirm the 🔍 **Permission Detective** button appears bottom-right.
4. Click it — the overlay should slide in with Object/Record ID pre-filled
   from the URL.
5. Enter a Field API Name (e.g. `Amount` on an Opportunity) and a target
   User Id (`005...`) — use a test user with restricted permissions to
   exercise the "denied"/"partial" paths, not just your own admin access.
6. Click **Analyze** and verify:
   - Record-level access badges match what you'd see in Setup → Sharing.
   - FLS table matches Setup → Profiles/Permission Sets → Field-Level
     Security for that field.
   - Object CRUD table matches the Profile/Permission Set object settings.
   - The permission chain correctly marks the first failing step and stops
     coloring subsequent steps as "reached."
7. Open the service worker console (`chrome://extensions` → the extension
   card → **Inspect views: service worker**) and confirm no errors on a
   normal run; then deliberately test a 401 (expire the session by logging
   out in another tab) and a 403 (test with a user lacking API Enabled) to
   confirm the error messages surface correctly in the overlay.
8. Test SPA navigation: from one record, use Salesforce's own UI to
   navigate to a different record without a full page reload, and confirm
   the trigger button persists and the overlay's pre-filled Record ID/Object
   update on next open.

## 3. Package for Chrome Web Store upload

1. From the project root, run:
   ```
   node build.js
   ```
2. Review the console output:
   - Confirm "All required files present."
   - Read every `⚠` warning under "Manifest validation warnings" and
     resolve anything that isn't intentional (e.g., missing
     `host_permissions`, a permission used in code but not declared).
3. Confirm `permission-detective-v<version>.zip` was created at the project
   root, and that `dist/` contains the minified files you expect.
4. Sanity-check the zip has `manifest.json` at its root (not nested inside a
   subfolder) — Chrome Web Store requires this. You can verify with:
   ```
   Expand-Archive -Path permission-detective-v1.0.0.zip -DestinationPath verify_zip
   Get-ChildItem verify_zip
   ```
5. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole),
   select the extension (or **New Item** for a first submission), and upload
   the zip.
6. Fill in the listing using `STORE_LISTING.md` (short/detailed description,
   screenshots with the suggested captions) and link `PRIVACY_POLICY.md`'s
   content from a publicly hosted URL in the **Privacy practices** section.
7. Under **Permissions justification**, paste the relevant sections from
   `CHROME_REVIEW_CHECKLIST.md`.
8. Submit for review.

## 4. Auto-updates

**If distributing through the Chrome Web Store (recommended path):**
Updates are automatic — Chrome Web Store assigns and manages the update URL
itself. Do **not** add `update_url` to `manifest.json`; a submission that
includes it will be rejected. To ship an update, bump `"version"` in
`manifest.json`, re-run `node build.js`, and upload the new zip as a new
package version in the dashboard. Users' browsers pick it up automatically
within Chrome's normal update-check interval (typically within a few hours).

**If self-hosting instead (enterprise/sideloaded deployment, not CWS):**
This path only applies if you are *not* distributing via the Chrome Web
Store — e.g., pushing the extension via `ExtensionInstallForcelist` policy
to managed devices from your own infrastructure.
1. Add to `manifest.json`:
   ```json
   "update_url": "https://your-domain.example.com/updates.xml"
   ```
2. Host an update manifest XML at that URL:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
     <app appid="<your-extension-id>">
       <updatecheck codebase="https://your-domain.example.com/permission-detective.crx"
                    version="1.0.1" />
     </app>
   </gupdate>
   ```
3. Package and sign a `.crx` (`chrome://extensions` → **Pack extension**, or
   `chrome.exe --pack-extension=permission-detective --pack-extension-key=key.pem`),
   host it at the `codebase` URL above, and bump the `version` in both the
   XML and `manifest.json` on each release.
4. Chrome checks the `update_url` periodically on managed installs and
   updates automatically — there is no dashboard involved in this path.
