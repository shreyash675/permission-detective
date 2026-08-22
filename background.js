// Permission Detective — background service worker
// Acts as the API engine: reads the Salesforce session cookie and makes
// authenticated REST calls on behalf of the content script/overlay
// (kept out of the content script to avoid page-CSP / CORS restrictions).

const API_VERSION = 'v63.0';

// Clicking the toolbar icon toggles the overlay — this fires only because
// manifest.json's "action" has no default_popup. Nothing is injected onto
// the page until the user actually asks for it.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { action: 'toggleOverlay' }, () => {
    if (chrome.runtime.lastError) {
      console.warn(
        '[Permission Detective] Could not reach the content script on this tab (not a Salesforce page, or it needs a refresh after install/reload).',
        chrome.runtime.lastError.message
      );
    }
  });
});

/**
 * Finds every plausible "sid" session cookie for this org — not just the
 * first match. Evidence from testing: a cookie can be genuinely PRESENT
 * and readable (e.g. one scoped to lightning.force.com) yet still get a
 * real 401 from the REST API, while a different cookie for the same org
 * (e.g. scoped to my.salesforce.com) works — the UI-authenticating cookie
 * and the API-authenticating cookie aren't always the same one. Returning
 * every candidate lets the caller actually try each one against the real
 * API instead of guessing which single domain "should" be correct.
 *
 * @param {string} instanceUrl - the page's origin, e.g. "https://myorg.lightning.force.com"
 * @returns {Promise<{
 *   candidates: Array<{ value: string, foundOn: string }>,
 *   permissionIssue?: boolean,
 *   hasApiDomainCookie?: boolean,
 *   triedDomains: string[],
 *   cookieDump: string[]
 * }>}
 */
async function findSessionCookieCandidates(instanceUrl) {
  const instanceMatch = instanceUrl.match(/^https?:\/\/([^.]+)\./);
  const instance = instanceMatch ? instanceMatch[1] : null;

  const candidateDomains = [];
  if (instance) {
    candidateDomains.push(`https://${instance}.my.salesforce.com`);
    candidateDomains.push(`https://${instance}.salesforce.com`);
    candidateDomains.push(`https://${instance}.lightning.force.com`);
  }

  // NOTE: chrome.permissions.contains() is NOT a reliable gate here — for an
  // unpacked extension it reports true for anything declared in the manifest
  // even when the browser's "Site access" UI has actually restricted runtime
  // access to a single domain. The only trustworthy test is to attempt the
  // cookie read and see what actually comes back, which is what we do below.
  const candidates = [];
  const seenValues = new Set();

  const addCandidate = (value, domain) => {
    if (!value || seenValues.has(value)) return;
    candidates.push({ value, foundOn: domain });
    seenValues.add(value);
  };

  for (const domain of candidateDomains) {
    try {
      const cookie = await chrome.cookies.get({ url: domain, name: 'sid' });
      if (cookie) addCandidate(cookie.value, domain);
    } catch (err) {
      console.warn(`[Permission Detective] cookie lookup failed for ${domain}`, err);
    }
  }

  // Broad search across every readable "sid" cookie. A Salesforce session id
  // is formatted "{orgId}!{sessionKey}", so cookies belonging to THIS org can
  // be identified by matching the orgId prefix even when the My Domain name
  // differs between the Lightning host and the API host (the approach
  // Salesforce Inspector uses). Same-org cookies are prioritised, and
  // my.salesforce.com is preferred since that's the API-serving domain.
  try {
    const allSidCookies = await chrome.cookies.getAll({ name: 'sid' });
    const orgIds = new Set(candidates.map((c) => c.value.split('!')[0]).filter(Boolean));

    const salesforceCookies = allSidCookies.filter((c) => {
      const d = c.domain || '';
      return d.endsWith('salesforce.com') || d.endsWith('force.com');
    });

    const sameOrg = salesforceCookies.filter((c) => orgIds.has(c.value.split('!')[0]));
    const others = salesforceCookies.filter((c) => !orgIds.has(c.value.split('!')[0]));
    const apiFirst = (list) => [
      ...list.filter((c) => (c.domain || '').includes('my.salesforce.com')),
      ...list.filter((c) => !(c.domain || '').includes('my.salesforce.com'))
    ];

    [...apiFirst(sameOrg), ...apiFirst(others)].forEach((c) => {
      addCandidate(c.value, `https://${(c.domain || '').replace(/^\./, '')}`);
    });
  } catch (err) {
    console.warn('[Permission Detective] broad cookie search failed', err);
  }

  // The API session lives on my.salesforce.com. If we could not read a cookie
  // there, runtime site access for that domain is almost certainly missing —
  // the browser only offers to grant access to sites you actually visit, and
  // nobody browses the API domain directly.
  const hasApiDomainCookie = candidates.some((c) => c.foundOn.includes('my.salesforce.com'));

  const triedDomains = [...candidateDomains, '*.salesforce.com (broad search)'];

  // Real diagnostic instead of a domain guess: list every cookie NAME
  // (never values — safe to surface in the UI) actually present on each
  // domain, only computed when nothing usable was found, so failures are
  // actionable instead of a dead end.
  let cookieDump = [];
  if (!candidates.length) {
    for (const domain of candidateDomains) {
      try {
        const allCookiesForDomain = await chrome.cookies.getAll({ url: domain });
        const names = allCookiesForDomain.map((c) => c.name).join(', ') || '(no cookies readable)';
        cookieDump.push(`${domain} -> [${names}]`);
      } catch (err) {
        cookieDump.push(`${domain} -> (lookup failed: ${err.message})`);
      }
    }
    console.error('[Permission Detective] No Salesforce session cookie ("sid") found. Domains tried:', triedDomains);
    console.error('[Permission Detective] Cookie dump:', cookieDump);
  } else {
    console.log(
      `[Permission Detective] Found ${candidates.length} session cookie candidate(s):`,
      candidates.map((c) => c.foundOn)
    );
    if (!hasApiDomainCookie) {
      console.warn(
        '[Permission Detective] No cookie readable on my.salesforce.com (the API domain) — site access for that domain is likely not granted.'
      );
    }
  }

  return { candidates, triedDomains, cookieDump, hasApiDomainCookie };
}

/** Opens the one-click runtime permission grant page. */
async function openGrantAccessPage() {
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('grant-access.html'),
      type: 'popup',
      width: 520,
      height: 480
    });
  } catch (err) {
    console.warn('[Permission Detective] could not open grant-access popup', err);
  }
}

/**
 * GETs a Salesforce REST API URL with the session id as a Bearer token,
 * translating common failure modes into clear errors. Shared by
 * querySalesforce and describeField.
 * @param {string} url
 * @param {string} sessionId
 * @returns {Promise<object>} parsed JSON response
 */
async function salesforceFetch(url, sessionId) {
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sessionId}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (networkErr) {
    console.error('[Permission Detective] Network error calling Salesforce API', {
      url,
      error: networkErr
    });
    throw new Error(`Network error while calling Salesforce API: ${networkErr.message}`);
  }

  if (response.status === 401) {
    console.error('[Permission Detective] Session expired (401)', { url });
    throw new Error('Salesforce session expired or invalid (401). Please refresh the Salesforce tab and try again.');
  }

  if (response.status === 403) {
    console.error('[Permission Detective] Insufficient API access (403)', { url });
    throw new Error('Insufficient API access (403). Your user/profile may lack API Enabled permission.');
  }

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      /* ignore body read failure */
    }
    console.error('[Permission Detective] Salesforce API error', {
      url,
      status: response.status,
      body
    });
    throw new Error(`Salesforce API error ${response.status}: ${body || response.statusText}`);
  }

  try {
    return await response.json();
  } catch (parseErr) {
    console.error('[Permission Detective] Failed to parse Salesforce API response', { url, error: parseErr });
    throw new Error(`Failed to parse Salesforce API response: ${parseErr.message}`);
  }
}

/**
 * Runs a SOQL query against the Salesforce REST API.
 * @param {string} instanceUrl - e.g. "https://myorg.my.salesforce.com"
 * @param {string} sessionId - Bearer token (Salesforce session id)
 * @param {string} soql
 * @returns {Promise<object>} parsed JSON response ({ totalSize, done, records })
 */
async function querySalesforce(instanceUrl, sessionId, soql) {
  const url = `${instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  return salesforceFetch(url, sessionId);
}

/** Escapes a value for use inside a single-quoted SOQL string literal. */
function escapeSoql(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Finds active users by name/username/email, for the User ID field's
 * search-as-you-type picker — so an admin can type "Jane" instead of
 * hand-copying an 18-char Id from Setup.
 * @returns {Promise<{ users: Array<{ id: string, name: string, username: string, email: string }> }>}
 */
async function searchUsers(instanceUrl, sessionId, term) {
  const escaped = escapeSoql(term);
  const soql = `
    SELECT Id, Name, Username, Email
    FROM User
    WHERE IsActive = true
    AND (Name LIKE '%${escaped}%' OR Username LIKE '%${escaped}%' OR Email LIKE '%${escaped}%')
    ORDER BY Name
    LIMIT 10
  `;
  const result = await querySalesforce(instanceUrl, sessionId, soql);
  const users = (result.records || []).map((r) => ({
    id: r.Id,
    name: r.Name,
    username: r.Username,
    email: r.Email
  }));
  return { users };
}

// Caches sobject describe results per (instanceUrl, objectApiName) for the
// life of the service worker, since the same object is often described
// multiple times per record (once per field the user clicks, plus once per
// analysis run).
const describeCache = new Map();

async function describeObjectCached(instanceUrl, sessionId, objectApiName) {
  const cacheKey = `${instanceUrl}|${objectApiName}`;
  if (describeCache.has(cacheKey)) {
    return describeCache.get(cacheKey);
  }
  const url = `${instanceUrl}/services/data/${API_VERSION}/sobjects/${objectApiName}/describe`;
  const promise = salesforceFetch(url, sessionId).catch((err) => {
    describeCache.delete(cacheKey); // don't cache failures
    throw err;
  });
  describeCache.set(cacheKey, promise);
  return promise;
}

/**
 * Looks up whether a field is FLS-controllable at all ("permissionable").
 * Required/system standard fields (e.g. Opportunity.StageName) never have
 * FieldPermissions rows because FLS doesn't apply to them — they're always
 * accessible whenever object/record access allows. Without this check, a
 * field with zero FieldPermissions rows is indistinguishable from a field
 * that's genuinely denied for every assignment.
 * Degrades gracefully (returns permissionable: null = "unknown") on any
 * failure rather than breaking the overall analysis — a real auth failure
 * still surfaces via the other parallel queries in analyzePermissions.
 * @returns {Promise<{ permissionable: boolean|null }>}
 */
async function describeField(instanceUrl, sessionId, objectApiName, fieldApiName) {
  try {
    const describeResult = await describeObjectCached(instanceUrl, sessionId, objectApiName);
    const field = (describeResult.fields || []).find(
      (f) => f.name && f.name.toLowerCase() === fieldApiName.toLowerCase()
    );
    if (!field) {
      console.warn(`[Permission Detective] Field "${fieldApiName}" not found in describe for ${objectApiName}`);
      return { permissionable: null };
    }
    return { permissionable: !!field.permissionable };
  } catch (err) {
    console.warn(`[Permission Detective] describeField failed for ${objectApiName}.${fieldApiName}`, err);
    return { permissionable: null };
  }
}

/**
 * Resolves a field's real API name from its visible Lightning label (e.g.
 * "Quantity" -> "Quantity__c"), for when the content script's DOM detection
 * only found a human-readable label, not an API name. Strips common
 * Lightning label decorations (trailing "*" for required, ":") before
 * matching, since the DOM label and describe label don't always match
 * byte-for-byte.
 *
 * Deliberately does NOT catch its own errors (unlike describeField) — a 401
 * here needs to propagate up to withSessionRetry so it can retry with the
 * next session cookie candidate instead of silently reporting "not found."
 * The message handler / content.js already treat any failure the same way
 * (fall back to manual entry), so nothing is lost by letting this throw.
 *
 * @returns {Promise<{ apiName: string|null, label: string|null }>}
 */
async function resolveFieldApiNameByLabel(instanceUrl, sessionId, objectApiName, labelHint) {
  const normalize = (s) => s.replace(/[*:]+$/, '').trim().toLowerCase();
  const target = normalize(labelHint);

  const describeResult = await describeObjectCached(instanceUrl, sessionId, objectApiName);
  const field = (describeResult.fields || []).find((f) => f.label && normalize(f.label) === target);
  if (!field) {
    console.warn(`[Permission Detective] No field found with label "${labelHint}" on ${objectApiName}`);
    return { apiName: null, label: null };
  }
  return { apiName: field.name, label: field.label };
}

/**
 * Runs the full permission analysis for a given user/record/field.
 * @returns {Promise<{
 *   recordAccess: { hasRead: boolean, hasEdit: boolean, hasDelete: boolean, hasTransfer: boolean, maxAccessLevel: string|null },
 *   fls: Array<{ field: string, read: boolean, edit: boolean, source: 'Profile'|'Permission Set', sourceName: string }>,
 *   objectCrud: Array<{ read: boolean, edit: boolean, delete: boolean, source: 'Profile'|'Permission Set', sourceName: string }>,
 *   userAssignments: Array<{ name: string, type: string, profileName: string|null }>,
 *   fieldMeta: { permissionable: boolean|null }
 * }>}
 */
async function analyzePermissions(instanceUrl, sessionId, userId, recordId, objectApiName, fieldApiName) {
  const userRecordAccessSoql = `
    SELECT RecordId, HasReadAccess, HasEditAccess, HasDeleteAccess, HasTransferAccess, MaxAccessLevel
    FROM UserRecordAccess
    WHERE UserId = '${userId}' AND RecordId = '${recordId}'
  `;

  // Parent.Name/.Label are selected for real Permission Sets; Parent.Profile.Name
  // is selected separately because a Profile's underlying access is stored on a
  // hidden, auto-generated PermissionSet whose own Name is a cryptic system
  // string (e.g. "X00ex00000018ozT_128_09_43_34_1") — the real, human-readable
  // Profile label lives on Parent.Profile.Name instead. See sourceNameOf().
  const fieldPermissionsSoql = `
    SELECT Field, PermissionsRead, PermissionsEdit, ParentId, Parent.Name, Parent.Label, Parent.Type, Parent.Profile.Name
    FROM FieldPermissions
    WHERE Field = '${objectApiName}.${fieldApiName}'
    AND ParentId IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}')
  `;

  const objectPermissionsSoql = `
    SELECT PermissionsRead, PermissionsEdit, PermissionsDelete, Parent.Name, Parent.Label, Parent.Type, Parent.Profile.Name
    FROM ObjectPermissions
    WHERE SobjectType = '${objectApiName}'
    AND ParentId IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}')
  `;

  const userAssignmentsSoql = `
    SELECT PermissionSet.Name, PermissionSet.Type, PermissionSet.Profile.Name
    FROM PermissionSetAssignment
    WHERE AssigneeId = '${userId}'
  `;

  const [recordAccessRes, fieldPermsRes, objectPermsRes, userAssignmentsRes, fieldMeta] = await Promise.all([
    querySalesforce(instanceUrl, sessionId, userRecordAccessSoql),
    querySalesforce(instanceUrl, sessionId, fieldPermissionsSoql),
    querySalesforce(instanceUrl, sessionId, objectPermissionsSoql),
    querySalesforce(instanceUrl, sessionId, userAssignmentsSoql),
    describeField(instanceUrl, sessionId, objectApiName, fieldApiName)
  ]);

  const recordAccessRecord = recordAccessRes.records && recordAccessRes.records[0];
  const recordAccess = {
    hasRead: !!(recordAccessRecord && recordAccessRecord.HasReadAccess),
    hasEdit: !!(recordAccessRecord && recordAccessRecord.HasEditAccess),
    hasDelete: !!(recordAccessRecord && recordAccessRecord.HasDeleteAccess),
    hasTransfer: !!(recordAccessRecord && recordAccessRecord.HasTransferAccess),
    maxAccessLevel: recordAccessRecord ? recordAccessRecord.MaxAccessLevel : null
  };

  const sourceOf = (parent) => (parent && parent.Type === 'Profile' ? 'Profile' : 'Permission Set');
  // For a Profile, the real display name lives on Parent.Profile.Name — the
  // PermissionSet's own Name/Label is a hidden, system-generated string with
  // no meaning to an admin. For a real Permission Set, prefer its Label
  // (human-readable) over Name (developer/API name).
  const sourceNameOf = (parent) => {
    if (!parent) return 'Unknown';
    if (parent.Type === 'Profile') {
      return (parent.Profile && parent.Profile.Name) || parent.Name || 'Unknown';
    }
    return parent.Label || parent.Name || 'Unknown';
  };

  // Salesforce can create multiple PermissionSetAssignment rows for the same
  // effective grant (e.g. a permission set reachable both by direct
  // assignment and via one or more Permission Set Groups) — each is a real,
  // distinct assignment row, but they produce identical-looking FLS/CRUD/
  // assignment entries that add no information when shown as separate rows.
  // Collapse to one row per distinct value.
  const dedupeBy = (list, keyFn) => {
    const seen = new Set();
    return list.filter((item) => {
      const key = keyFn(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const fls = dedupeBy(
    (fieldPermsRes.records || []).map((r) => ({
      field: r.Field,
      read: !!r.PermissionsRead,
      edit: !!r.PermissionsEdit,
      source: sourceOf(r.Parent),
      sourceName: sourceNameOf(r.Parent)
    })),
    (f) => `${f.source}|${f.sourceName}|${f.read}|${f.edit}`
  );

  const objectCrud = dedupeBy(
    (objectPermsRes.records || []).map((r) => ({
      read: !!r.PermissionsRead,
      edit: !!r.PermissionsEdit,
      delete: !!r.PermissionsDelete,
      source: sourceOf(r.Parent),
      sourceName: sourceNameOf(r.Parent)
    })),
    (o) => `${o.source}|${o.sourceName}|${o.read}|${o.edit}|${o.delete}`
  );

  const userAssignments = dedupeBy(
    (userAssignmentsRes.records || []).map((r) => ({
      name: r.PermissionSet ? r.PermissionSet.Name : 'Unknown',
      type: r.PermissionSet ? r.PermissionSet.Type : 'Unknown',
      profileName: r.PermissionSet && r.PermissionSet.Profile ? r.PermissionSet.Profile.Name : null
    })),
    (a) => `${a.name}|${a.type}|${a.profileName}`
  );

  return { recordAccess, fls, objectCrud, userAssignments, fieldMeta };
}

/**
 * Uses Salesforce's own frontdoor.jsp session-bridging endpoint — the same
 * mechanism Salesforce CLI and other first-party tools use — to establish
 * a my.salesforce.com session (and its cookie) from a session id that's
 * still validly logged in but wasn't itself accepted as a REST API Bearer
 * token (observed: a lightning.force.com-scoped "sid" can authenticate the
 * UI while that org's separate my.salesforce.com session has quietly timed
 * out from inactivity, since browsing Lightning pages doesn't refresh it).
 * Best-effort: failures are swallowed since the caller just retries and
 * reports its own error either way.
 */
async function bridgeSessionToMyDomain(instance, sessionIdToTry) {
  const bridgeUrl = `https://${instance}.my.salesforce.com/secur/frontdoor.jsp?sid=${encodeURIComponent(
    sessionIdToTry
  )}&retURL=%2F`;
  try {
    await fetch(bridgeUrl, { credentials: 'include', redirect: 'follow' });
    console.log(`[Permission Detective] Attempted session bridge to ${instance}.my.salesforce.com`);
  } catch (err) {
    console.warn('[Permission Detective] frontdoor.jsp session bridge failed', err);
  }
}

/**
 * Tries `operation(apiHost, sessionValue)` against every plausible session
 * cookie candidate for this org, moving to the next candidate only when
 * the current one specifically fails with a 401 (present but not valid
 * for API calls). If every candidate 401s, attempts one automatic
 * frontdoor.jsp session bridge to my.salesforce.com and retries once more
 * before finally giving up. Shared by every message handler that needs to
 * talk to Salesforce.
 * @throws {Error}
 */
async function withSessionRetry(instanceUrl, callerSuppliedSessionId, operation) {
  if (callerSuppliedSessionId) {
    return operation(instanceUrl, callerSuppliedSessionId);
  }

  const tryAllCandidates = async () => {
    const { candidates, triedDomains, cookieDump, hasApiDomainCookie } =
      await findSessionCookieCandidates(instanceUrl);

    if (!candidates.length) {
      const dumpText = cookieDump.length ? ' ' + cookieDump.join(' | ') : '';
      throw new Error(
        `No Salesforce session cookie ("sid") found. Tried: ${triedDomains.join(', ')}. Make sure you are logged in, then refresh the Salesforce tab and try again.${dumpText}`
      );
    }

    for (const candidate of candidates) {
      try {
        const result = await operation(candidate.foundOn, candidate.value);
        console.log(`[Permission Detective] Session cookie from ${candidate.foundOn} was accepted.`);
        return { success: true, result };
      } catch (err) {
        const isAuthFailure = err.message.includes('(401)');
        if (!isAuthFailure) throw err; // a real non-auth error (403, network, parse) — don't mask it by retrying
        console.warn(`[Permission Detective] Cookie from ${candidate.foundOn} was rejected (401) — trying next candidate if any.`);
      }
    }

    return { success: false, candidates, hasApiDomainCookie };
  };

  const firstAttempt = await tryAllCandidates();
  if (firstAttempt.success) return firstAttempt.result;

  const instanceMatch = instanceUrl.match(/^https?:\/\/([^.]+)\./);
  const instance = instanceMatch ? instanceMatch[1] : null;

  if (instance) {
    console.warn('[Permission Detective] All session cookies rejected — attempting frontdoor.jsp bridge to my.salesforce.com.');
    await bridgeSessionToMyDomain(instance, firstAttempt.candidates[0].value);

    const secondAttempt = await tryAllCandidates();
    if (secondAttempt.success) return secondAttempt.result;
  }

  // Every cookie we could READ was rejected, and we could not read one on the
  // API domain at all — that's the signature of missing runtime site access
  // for my.salesforce.com, not an expired login. Open the one-click grant page.
  if (!firstAttempt.hasApiDomainCookie) {
    await openGrantAccessPage();
    throw new Error(
      'Permission Detective cannot read the Salesforce API session, because the browser has not granted it ' +
        'access to *.my.salesforce.com (the domain that serves the REST API). Lightning pages authenticate on ' +
        'a different domain whose session is not valid for API calls. A tab has been opened — click ' +
        '"Grant access" there, then reload this Salesforce tab and try again.'
    );
  }

  throw new Error(
    `Found ${firstAttempt.candidates.length} Salesforce session cookie(s) (on: ${firstAttempt.candidates
      .map((c) => c.foundOn)
      .join(', ')}) but the API rejected every one with 401, even after attempting to refresh the session. ` +
      'Please log out of Salesforce and back in, then try again.'
  );
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'analyzePermissions') {
    (async () => {
      try {
        const data = await withSessionRetry(request.instanceUrl, request.sessionId, (apiHost, sessionValue) =>
          analyzePermissions(
            apiHost,
            sessionValue,
            request.userId,
            request.recordId,
            request.objectApiName,
            request.fieldApiName
          )
        );
        sendResponse({ success: true, data });
      } catch (err) {
        console.error('[Permission Detective] analyzePermissions failed', {
          request,
          error: err
        });
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // keep the message channel open for the async response
  }

  if (request.action === 'resolveFieldApiName') {
    (async () => {
      try {
        const data = await withSessionRetry(request.instanceUrl, request.sessionId, (apiHost, sessionValue) =>
          resolveFieldApiNameByLabel(apiHost, sessionValue, request.objectApiName, request.labelHint)
        );
        sendResponse({ success: true, data });
      } catch (err) {
        console.error('[Permission Detective] resolveFieldApiName failed', {
          request,
          error: err
        });
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // keep the message channel open for the async response
  }

  if (request.action === 'searchUsers') {
    (async () => {
      try {
        const data = await withSessionRetry(request.instanceUrl, request.sessionId, (apiHost, sessionValue) =>
          searchUsers(apiHost, sessionValue, request.term)
        );
        sendResponse({ success: true, data });
      } catch (err) {
        console.error('[Permission Detective] searchUsers failed', {
          request,
          error: err
        });
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // keep the message channel open for the async response
  }
});
