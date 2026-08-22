// Permission Detective — content script
// Detects Salesforce Lightning record pages, injects the trigger button
// and analysis overlay, detects clicked fields / the current user, and
// talks to background.js. Rendering of results is delegated to
// window.renderResults(data), supplied by overlay.js.

const PD_RECORD_PAGE_RE = /\/lightning\/r\/(\w+)\/([a-zA-Z0-9]{15,18})\/view/;

let pdLastClickedField = null; // { fieldApiName: string|null, labelHint: string|null }
let pdLastPathname = window.location.pathname;

/** Parses the current URL for a Lightning record page. Returns null if not one. */
function detectRecordPage() {
  const match = window.location.pathname.match(PD_RECORD_PAGE_RE);
  if (!match) return null;
  return { objectApiName: match[1], recordId: match[2] };
}

function getInstanceUrl() {
  return window.location.origin;
}

/**
 * Attempts to resolve a field API name from a clicked element, trying
 * several strategies in order of reliability.
 */
function detectFieldApiName(target) {
  if (!(target instanceof Element)) return { fieldApiName: null, labelHint: null };

  // a) data-field / data-output-field attribute on the element or an ancestor
  const dataFieldEl = target.closest('[data-field], [data-output-field]');
  if (dataFieldEl) {
    const value =
      dataFieldEl.getAttribute('data-field') || dataFieldEl.getAttribute('data-output-field');
    if (value) return { fieldApiName: value, labelHint: null };
  }

  // b) lightning-output-field custom element with a field-name attribute
  const outputFieldEl = target.closest('lightning-output-field');
  if (outputFieldEl) {
    const fieldName = outputFieldEl.getAttribute('field-name');
    if (fieldName) return { fieldApiName: fieldName, labelHint: null };
  }

  // c) data-target-selection-name="sfdc:RecordField.{Object}.{Field}" —
  //    used by Lightning's own record layout rendering on many page types
  //    (standard record detail, related lists, some Lightning App Builder
  //    components), giving the exact API name with no lookup needed.
  const targetSelectionEl = target.closest('[data-target-selection-name]');
  if (targetSelectionEl) {
    const raw = targetSelectionEl.getAttribute('data-target-selection-name');
    const match = raw && raw.match(/^sfdc:RecordField\.[^.]+\.(.+)$/);
    if (match) return { fieldApiName: match[1], labelHint: null };
  }

  // d) fallback — walk up to the SLDS form element and read its label text
  //    (this is a human-readable label, not a guaranteed API name; the
  //    caller resolves it to a real API name via the Describe API)
  const formElementEl = target.closest('.slds-form-element');
  if (formElementEl) {
    const labelEl = formElementEl.querySelector('.slds-form-element__label');
    const labelHint = labelEl ? labelEl.textContent.trim() : null;
    if (labelHint) return { fieldApiName: null, labelHint };
  }

  return { fieldApiName: null, labelHint: null };
}

function handleDocumentClick(event) {
  if (!detectRecordPage()) return;
  // Ignore clicks inside our own UI
  if (event.target.closest('#pd-overlay')) return;

  const detected = detectFieldApiName(event.target);
  if (detected.fieldApiName || detected.labelHint) {
    pdLastClickedField = detected;
    updateFieldInputFromLastClick();
  }
}

function updateFieldInputFromLastClick() {
  const fieldInput = document.getElementById('pd-field-api');
  if (!fieldInput || !pdLastClickedField) return;

  if (pdLastClickedField.fieldApiName) {
    fieldInput.value = pdLastClickedField.fieldApiName;
    fieldInput.placeholder = 'Object__c.Field__c';
    return;
  }

  if (pdLastClickedField.labelHint) {
    resolveFieldApiNameFromLabel(pdLastClickedField.labelHint);
  }
}

/**
 * Only a human-readable label was found in the DOM (not a real API name) —
 * ask background.js to resolve it via the Salesforce Describe API, which
 * knows every field's real API name for the current object. Guards against
 * a race if the user clicks a different field before this resolves.
 */
function resolveFieldApiNameFromLabel(labelHint) {
  const fieldInput = document.getElementById('pd-field-api');
  const objectInput = document.getElementById('pd-object-api');
  if (!fieldInput || !objectInput) return;

  const objectApiName = objectInput.value.trim();
  if (!objectApiName) {
    fieldInput.placeholder = `Detected label "${labelHint}" — enter API name`;
    return;
  }

  fieldInput.value = '';
  fieldInput.placeholder = `Looking up API name for "${labelHint}"…`;

  chrome.runtime.sendMessage(
    {
      action: 'resolveFieldApiName',
      instanceUrl: getInstanceUrl(),
      objectApiName,
      labelHint
    },
    (response) => {
      // A newer click may have superseded this lookup — don't clobber it.
      if (!pdLastClickedField || pdLastClickedField.labelHint !== labelHint) return;

      const currentFieldInput = document.getElementById('pd-field-api');
      if (!currentFieldInput) return; // overlay closed meanwhile

      if (chrome.runtime.lastError) {
        currentFieldInput.placeholder = `Detected label "${labelHint}" — enter API name`;
        return;
      }
      if (response && response.success && response.data.apiName) {
        currentFieldInput.value = response.data.apiName;
        currentFieldInput.placeholder = 'Object__c.Field__c';
      } else {
        currentFieldInput.placeholder = `Detected label "${labelHint}" — enter API name`;
      }
    }
  );
}

/**
 * Best-effort detection of the current Salesforce user id.
 * Note: content scripts run in an isolated JS world, so page-level global
 * variables (e.g. a bare `UserContext` set by page scripts) are generally
 * NOT visible here even though the DOM is shared — only variables the page
 * explicitly exposes via the DOM (meta tags, data attributes) are reliable.
 */
function detectUserId() {
  const meta = document.querySelector('meta[name="user-id"], meta[name="userid"]');
  if (meta && meta.content) return meta.content.trim();

  const dataEl = document.querySelector('[data-userid]');
  if (dataEl) {
    const value = dataEl.getAttribute('data-userid');
    if (value) return value.trim();
  }

  try {
    if (window.UserContext && window.UserContext.id) {
      return window.UserContext.id;
    }
  } catch (e) {
    // isolated world — expected to fail silently on most Lightning pages
  }

  return null;
}

function buildOverlayPanel() {
  const overlay = document.createElement('div');
  overlay.id = 'pd-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    top: '0',
    right: '0',
    width: '420px',
    height: '100vh',
    background: '#ffffff',
    borderLeft: '1px solid #dddbda',
    boxShadow: '-2px 0 8px rgba(0, 0, 0, 0.15)',
    zIndex: '999999',
    display: 'flex',
    flexDirection: 'column',
    transform: 'translateX(100%)',
    transition: 'transform 0.2s ease-out',
    fontFamily: '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
    fontSize: '13px',
    color: '#16325c'
  });

  overlay.innerHTML = `
    <div id="pd-header" style="display:flex;align-items:center;justify-content:space-between;
         padding:12px 16px;background:#032d60;color:#fff;font-weight:600;">
      <span>Permission Detective</span>
      <button id="pd-close-btn" type="button" style="background:none;border:none;color:#fff;
              font-size:20px;line-height:1;cursor:pointer;">×</button>
    </div>
    <div id="pd-body" style="padding:16px;overflow-y:auto;flex:1;">
      <div id="pd-context" style="display:flex;flex-direction:column;gap:10px;">
        ${pdField('pd-object-api', 'Object')}
        ${pdField('pd-record-id', 'Record ID')}
        ${pdField('pd-field-api', 'Field API Name (optional)', 'Leave blank for object-level access only')}
        <label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:#444;position:relative;">
          <span>User ID or Name</span>
          <input id="pd-user-id" type="text" autocomplete="off"
                 placeholder="Type a name, username, or paste a 005... ID" style="padding:6px 8px;
                 border:1px solid #c9c9c9;border-radius:4px;font-size:13px;" />
          <div id="pd-user-search-results" style="display:none;position:absolute;top:100%;left:0;
               right:0;margin-top:2px;max-height:180px;overflow-y:auto;background:#fff;
               border:1px solid #c9c9c9;border-radius:4px;box-shadow:0 2px 6px rgba(0,0,0,0.15);
               z-index:1000000;"></div>
          <span id="pd-user-selected-label" style="display:none;font-size:11px;color:#2e844a;"></span>
        </label>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button id="pd-analyze-btn" type="button" style="flex:1;background:#0176d3;color:#fff;
                border:none;border-radius:4px;padding:8px 12px;font-weight:600;cursor:pointer;">
          Analyze
        </button>
        <button id="pd-clear-btn" type="button" style="background:#fff;color:#0176d3;
                border:1px solid #0176d3;border-radius:4px;padding:8px 12px;font-weight:600;
                cursor:pointer;">
          Clear
        </button>
      </div>
      <div id="pd-results" style="margin-top:16px;display:none;"></div>
    </div>
  `;

  return overlay;
}

function pdField(id, labelText, placeholder = '') {
  return `
    <label style="display:flex;flex-direction:column;gap:2px;font-size:12px;color:#444;">
      <span>${labelText}</span>
      <input id="${id}" type="text" placeholder="${placeholder}" style="padding:6px 8px;
             border:1px solid #c9c9c9;border-radius:4px;font-size:13px;" />
    </label>
  `;
}

function injectOverlayPanel() {
  if (document.getElementById('pd-overlay')) return;

  const overlay = buildOverlayPanel();
  document.body.appendChild(overlay);

  overlay.querySelector('#pd-close-btn').addEventListener('click', closeOverlay);
  overlay.querySelector('#pd-analyze-btn').addEventListener('click', handleAnalyzeClick);
  overlay.querySelector('#pd-clear-btn').addEventListener('click', handleClearClick);
  setupUserSearch();
}

const PD_SALESFORCE_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
let pdUserSearchTimer = null;
let pdUserSearchToken = 0;

/**
 * Wires up the User ID field as a search-as-you-type picker: typing a
 * name/username/email queries background.js's searchUsers action and shows
 * matching users to click; pasting/typing a raw Salesforce Id is left alone
 * (no search fires) since the field's value is used as-is by Analyze either way.
 */
function setupUserSearch() {
  const input = document.getElementById('pd-user-id');
  const resultsEl = document.getElementById('pd-user-search-results');
  if (!input || !resultsEl) return;

  input.addEventListener('input', () => {
    const confirmEl = document.getElementById('pd-user-selected-label');
    if (confirmEl) confirmEl.style.display = 'none';

    const term = input.value.trim();
    if (pdUserSearchTimer) clearTimeout(pdUserSearchTimer);

    if (!term || term.length < 2 || PD_SALESFORCE_ID_RE.test(term)) {
      resultsEl.style.display = 'none';
      resultsEl.innerHTML = '';
      return;
    }

    const myToken = ++pdUserSearchToken;
    pdUserSearchTimer = setTimeout(() => {
      chrome.runtime.sendMessage(
        { action: 'searchUsers', instanceUrl: getInstanceUrl(), term },
        (response) => {
          if (myToken !== pdUserSearchToken) return; // a newer search superseded this one
          if (chrome.runtime.lastError || !response || !response.success) {
            resultsEl.style.display = 'none';
            return;
          }
          renderUserSearchResults(response.data.users, term);
        }
      );
    }, 300);
  });

  input.addEventListener('focus', () => {
    if (resultsEl.childElementCount > 0) resultsEl.style.display = 'block';
  });

  input.addEventListener('blur', () => {
    // Delay so a row's mousedown (which selects the user) still registers first.
    setTimeout(() => {
      resultsEl.style.display = 'none';
    }, 150);
  });
}

function renderUserSearchResults(users, term) {
  const resultsEl = document.getElementById('pd-user-search-results');
  if (!resultsEl) return;

  resultsEl.innerHTML = '';

  if (!users || !users.length) {
    const empty = document.createElement('div');
    empty.textContent = `No users found matching "${term}"`;
    Object.assign(empty.style, { padding: '8px', fontSize: '12px', color: '#706e6b' });
    resultsEl.appendChild(empty);
    resultsEl.style.display = 'block';
    return;
  }

  users.forEach((user) => {
    const row = document.createElement('div');
    Object.assign(row.style, {
      padding: '8px',
      fontSize: '12px',
      cursor: 'pointer',
      borderBottom: '1px solid #f3f3f3'
    });

    const nameEl = document.createElement('div');
    nameEl.textContent = user.name;
    Object.assign(nameEl.style, { fontWeight: '600', color: '#16325c' });

    const detailEl = document.createElement('div');
    detailEl.textContent = user.username;
    Object.assign(detailEl.style, { color: '#706e6b', fontSize: '11px' });

    row.appendChild(nameEl);
    row.appendChild(detailEl);

    row.addEventListener('mouseenter', () => {
      row.style.background = '#f3f3f3';
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = '';
    });

    // mousedown + preventDefault (not click) so this fires before the input's
    // blur handler would otherwise hide the dropdown first.
    row.addEventListener('mousedown', (event) => {
      event.preventDefault();
      selectUser(user);
    });

    resultsEl.appendChild(row);
  });

  resultsEl.style.display = 'block';
}

function selectUser(user) {
  const input = document.getElementById('pd-user-id');
  const resultsEl = document.getElementById('pd-user-search-results');
  const confirmEl = document.getElementById('pd-user-selected-label');
  if (!input) return;

  input.value = user.id;
  if (resultsEl) {
    resultsEl.style.display = 'none';
    resultsEl.innerHTML = '';
  }
  if (confirmEl) {
    confirmEl.textContent = `✓ ${user.name} (${user.username})`;
    confirmEl.style.display = 'block';
  }
}

function prefillContext() {
  const page = detectRecordPage();
  const objectInput = document.getElementById('pd-object-api');
  const recordInput = document.getElementById('pd-record-id');
  const userInput = document.getElementById('pd-user-id');

  if (page) {
    if (objectInput && !objectInput.value) objectInput.value = page.objectApiName;
    if (recordInput && !recordInput.value) recordInput.value = page.recordId;
  }

  if (userInput && !userInput.value) {
    const userId = detectUserId();
    if (userId) userInput.value = userId;
  }

  updateFieldInputFromLastClick();
}

let pdOverlayOpen = false;

function openOverlay() {
  injectOverlayPanel();
  prefillContext();
  const overlay = document.getElementById('pd-overlay');
  // force reflow so the transition runs even if just injected
  void overlay.offsetWidth;
  overlay.style.transform = 'translateX(0)';
  pdOverlayOpen = true;
}

function closeOverlay() {
  const overlay = document.getElementById('pd-overlay');
  if (!overlay) return;
  overlay.style.transform = 'translateX(100%)';
  pdOverlayOpen = false;
}

function toggleOverlayPanel() {
  if (pdOverlayOpen) {
    closeOverlay();
  } else {
    openOverlay();
  }
}

function handleClearClick() {
  // Object/Record ID are auto-detected from the current page and should stay
  // put — Clear only resets what the user actually typed in (Field API Name,
  // User ID). They'll update on their own when navigating to a different
  // record (see handlePossibleNavigation).
  ['pd-field-api', 'pd-user-id'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  pdLastClickedField = null;

  const userSearchResults = document.getElementById('pd-user-search-results');
  if (userSearchResults) {
    userSearchResults.style.display = 'none';
    userSearchResults.innerHTML = '';
  }
  const userSelectedLabel = document.getElementById('pd-user-selected-label');
  if (userSelectedLabel) userSelectedLabel.style.display = 'none';

  const results = document.getElementById('pd-results');
  if (results) {
    results.style.display = 'none';
    results.innerHTML = '';
  }
}

function handleAnalyzeClick() {
  const objectApiName = document.getElementById('pd-object-api').value.trim();
  const recordId = document.getElementById('pd-record-id').value.trim();
  const fieldApiName = document.getElementById('pd-field-api').value.trim();
  const userId = document.getElementById('pd-user-id').value.trim();
  const instanceUrl = getInstanceUrl();

  const resultsEl = document.getElementById('pd-results');

  // Field API Name is optional — leaving it blank checks only object- and
  // record-level access, which is a legitimate thing to want on its own.
  if (!objectApiName || !recordId || !userId) {
    resultsEl.style.display = 'block';
    resultsEl.innerHTML = '<div style="color:#ba0517;">Please fill in Object, Record ID, and User ID.</div>';
    return;
  }

  resultsEl.style.display = 'block';
  resultsEl.innerHTML = '<div style="color:#706e6b;font-style:italic;">Analyzing…</div>';

  chrome.runtime.sendMessage(
    {
      action: 'analyzePermissions',
      instanceUrl,
      userId,
      recordId,
      objectApiName,
      fieldApiName
    },
    (response) => {
      if (chrome.runtime.lastError) {
        resultsEl.innerHTML = `<div style="color:#ba0517;">${chrome.runtime.lastError.message}</div>`;
        return;
      }
      if (!response || !response.success) {
        resultsEl.innerHTML = `<div style="color:#ba0517;">${
          (response && response.error) || 'Unknown error.'
        }</div>`;
        return;
      }
      if (typeof window.renderResults === 'function') {
        window.renderResults(response.data);
      } else {
        console.error('[Permission Detective] overlay.js renderResults() not found');
        resultsEl.textContent = JSON.stringify(response.data, null, 2);
      }
    }
  );
}

/**
 * Re-checks the URL and re-injects/refreshes UI after Lightning's SPA
 * router navigates to a different record without a full page reload.
 */
function handlePossibleNavigation() {
  if (window.location.pathname === pdLastPathname) return;
  pdLastPathname = window.location.pathname;

  const page = detectRecordPage();
  if (!page) return;

  const objectInput = document.getElementById('pd-object-api');
  const recordInput = document.getElementById('pd-record-id');
  if (objectInput) objectInput.value = page.objectApiName;
  if (recordInput) recordInput.value = page.recordId;

  pdLastClickedField = null;
  const fieldInput = document.getElementById('pd-field-api');
  if (fieldInput) fieldInput.value = '';
}

function initPermissionDetective() {
  document.addEventListener('click', handleDocumentClick, true);

  const observer = new MutationObserver(handlePossibleNavigation);
  observer.observe(document.body, { childList: true, subtree: true });

  // Opened/closed by clicking the extension's toolbar icon (background.js's
  // chrome.action.onClicked handler) — no floating button injected into the
  // page itself, so nothing sits on top of the Salesforce UI until asked for.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'toggleOverlay') {
      toggleOverlayPanel();
      sendResponse({ success: true });
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPermissionDetective);
} else {
  initPermissionDetective();
}
