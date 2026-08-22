// Permission Detective — SLDS-styled results renderer
// Exposes window.renderResults(data), called by content.js after a
// successful analyzePermissions response. All DOM creation uses
// document.createElement (no innerHTML) to avoid injection risk.

const PD_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const PD_COLORS = {
  success: '#2E844A',
  warning: '#8C4B02',
  error: '#BA0517',
  info: '#0176D3',
  text: '#3E3E3C',
  border: '#DDDBDA',
  background: '#FAFAF9'
};

const PD_BADGE_TINTS = {
  success: '#effaf3',
  warning: '#fff8ee',
  error: '#fef3f2',
  info: '#eef4ff'
};

// ---------- helpers ----------

function createSection(title) {
  const section = document.createElement('div');
  section.style.marginTop = '18px';
  section.style.fontFamily = PD_FONT;

  const heading = document.createElement('h4');
  heading.textContent = title;
  heading.style.margin = '0 0 8px';
  heading.style.fontSize = '13px';
  heading.style.color = PD_COLORS.text;
  heading.style.fontWeight = '700';

  section.appendChild(heading);
  return section;
}

function createBadge(text, type) {
  const badge = document.createElement('span');
  badge.textContent = text;
  badge.style.display = 'inline-block';
  badge.style.fontFamily = PD_FONT;
  badge.style.fontSize = '12px';
  badge.style.fontWeight = '600';
  badge.style.padding = '3px 10px';
  badge.style.borderRadius = '12px';
  badge.style.color = PD_COLORS[type] || PD_COLORS.text;
  badge.style.background = PD_BADGE_TINTS[type] || PD_COLORS.background;
  badge.style.border = `1px solid ${PD_COLORS[type] || PD_COLORS.border}`;
  return badge;
}

function boolBadge(label, value) {
  const wrapper = document.createElement('div');
  wrapper.style.display = 'flex';
  wrapper.style.flexDirection = 'column';
  wrapper.style.alignItems = 'flex-start';
  wrapper.style.gap = '4px';

  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  labelEl.style.fontSize = '11px';
  labelEl.style.color = PD_COLORS.text;

  wrapper.appendChild(labelEl);
  wrapper.appendChild(createBadge(value ? '✅' : '❌', value ? 'success' : 'error'));
  return wrapper;
}

function createTable(headers, rows) {
  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.fontFamily = PD_FONT;
  table.style.fontSize = '12px';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headers.forEach((headerText) => {
    const th = document.createElement('th');
    th.textContent = headerText;
    th.style.textAlign = 'left';
    th.style.padding = '6px 8px';
    th.style.background = PD_COLORS.background;
    th.style.color = PD_COLORS.text;
    th.style.borderBottom = `1px solid ${PD_COLORS.border}`;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    row.forEach((cellContent) => {
      const td = document.createElement('td');
      td.style.padding = '6px 8px';
      td.style.borderBottom = `1px solid ${PD_COLORS.border}`;
      td.style.color = PD_COLORS.text;
      if (cellContent instanceof Node) {
        td.appendChild(cellContent);
      } else {
        td.textContent = cellContent;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  return table;
}

function pdWarningBox(text, type) {
  const box = document.createElement('div');
  box.textContent = text;
  box.style.marginTop = '8px';
  box.style.padding = '10px 12px';
  box.style.borderRadius = '4px';
  box.style.fontSize = '12px';
  box.style.fontFamily = PD_FONT;
  box.style.color = PD_COLORS[type];
  box.style.background = PD_BADGE_TINTS[type];
  box.style.border = `1px solid ${PD_COLORS[type]}`;
  return box;
}

function pdChainNode(title, status) {
  // status: 'pass' | 'block' | 'conditional' | 'neutral'
  const colorByStatus = {
    pass: 'success',
    block: 'error',
    conditional: 'warning',
    neutral: 'info'
  };
  const type = colorByStatus[status] || 'info';

  const node = document.createElement('div');
  node.textContent = title;
  node.style.fontFamily = PD_FONT;
  node.style.fontSize = '11px';
  node.style.fontWeight = '600';
  node.style.textAlign = 'center';
  node.style.padding = '8px 6px';
  node.style.borderRadius = '6px';
  node.style.color = PD_COLORS[type];
  node.style.background = PD_BADGE_TINTS[type];
  node.style.border = `1px solid ${PD_COLORS[type]}`;
  node.style.minWidth = '70px';
  node.style.flex = '1 1 0';
  return node;
}

function pdArrow() {
  const arrow = document.createElement('span');
  arrow.textContent = '→';
  arrow.style.color = PD_COLORS.text;
  arrow.style.fontSize = '14px';
  arrow.style.flex = '0 0 auto';
  return arrow;
}

/**
 * Builds the visual permission chain:
 * User → Profile/Perm Sets → Object CRUD → FLS → Record Access → Result
 * Stops coloring the chain "pass" at the first failing step and marks the
 * rest as not-reached, mirroring the real evaluation order Salesforce uses.
 */
function formatPermissionChain(data) {
  const hasAssignments = data.userAssignments && data.userAssignments.length > 0;
  const objectReadGranted = data.objectCrud.some((o) => o.read);
  // A field with no FieldPermissions rows isn't necessarily denied — fields
  // that aren't FLS-controllable (e.g. required standard fields like
  // StageName) never have rows at all, and are always accessible. Only
  // treat "no rows" as a block when the field is actually permissionable.
  const flsApplies = !(data.fieldMeta && data.fieldMeta.permissionable === false);
  const flsReadGranted = !flsApplies || data.fls.some((f) => f.read);
  const recordReadGranted = data.recordAccess.hasRead;

  const steps = [
    { title: 'Profile / Perm Sets', pass: hasAssignments },
    { title: 'Object CRUD', pass: objectReadGranted },
    { title: flsApplies ? 'Field-Level Security' : 'Field-Level Security (N/A)', pass: flsReadGranted },
    { title: 'Record Access', pass: recordReadGranted }
  ];

  let blockedAt = null;
  let reached = true;
  const statuses = steps.map((step) => {
    if (!reached) return 'neutral';
    if (step.pass) return 'pass';
    blockedAt = step.title;
    reached = false;
    return 'block';
  });

  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.alignItems = 'center';
  container.style.flexWrap = 'wrap';
  container.style.gap = '4px';
  container.style.marginTop = '8px';

  container.appendChild(pdChainNode('User', 'neutral'));
  container.appendChild(pdArrow());

  steps.forEach((step, i) => {
    container.appendChild(pdChainNode(step.title, statuses[i]));
    container.appendChild(pdArrow());
  });

  const resultStatus = blockedAt ? 'block' : 'pass';
  container.appendChild(
    pdChainNode(blockedAt ? 'ACCESS DENIED' : 'ACCESS GRANTED', resultStatus)
  );

  const wrapper = document.createElement('div');
  wrapper.appendChild(container);

  if (blockedAt) {
    wrapper.appendChild(pdWarningBox(`BLOCKED AT: ${blockedAt}`, 'error'));
  }

  return wrapper;
}

function pdGetInputValue(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function buildCopyDebugText(data) {
  const field = pdGetInputValue('pd-field-api');
  const object = pdGetInputValue('pd-object-api');
  const recordId = pdGetInputValue('pd-record-id');
  const userId = pdGetInputValue('pd-user-id');

  const flsNotApplicable = data.fieldMeta && data.fieldMeta.permissionable === false;
  const flsSummary = data.fls.length
    ? data.fls
        .map((f) => `${f.source} (${f.sourceName}): Read=${f.read}, Edit=${f.edit}`)
        .join('; ')
    : flsNotApplicable
      ? 'not FLS-controlled (always accessible)'
      : 'none found';

  const objectCrudSummary = data.objectCrud.length
    ? data.objectCrud
        .map(
          (o) => `${o.source} (${o.sourceName}): Read=${o.read}, Edit=${o.edit}, Delete=${o.delete}`
        )
        .join('; ')
    : 'none found';

  return (
    `Permission Analysis for ${field} on ${object} record ${recordId} for user ${userId}:\n` +
    `Record Access: Read=${data.recordAccess.hasRead}, Edit=${data.recordAccess.hasEdit}\n` +
    `FLS: ${flsSummary}\n` +
    `Object CRUD: ${objectCrudSummary}`
  );
}

// ---------- sections ----------

function buildSummaryCard(data) {
  const card = document.createElement('div');
  card.style.padding = '14px';
  card.style.borderRadius = '6px';
  card.style.border = `1px solid ${PD_COLORS.border}`;
  card.style.background = PD_COLORS.background;
  card.style.fontFamily = PD_FONT;

  const hasRead = data.recordAccess.hasRead;
  const hasEdit = data.recordAccess.hasEdit;

  let statusText;
  let statusType;
  if (!hasRead) {
    statusText = '❌ ACCESS DENIED';
    statusType = 'error';
  } else if (hasRead && !hasEdit) {
    statusText = '⚠️ PARTIAL ACCESS';
    statusType = 'warning';
  } else {
    statusText = '✅ ACCESS GRANTED';
    statusType = 'success';
  }

  const badge = createBadge(statusText, statusType);
  badge.style.fontSize = '14px';
  badge.style.padding = '6px 14px';
  card.appendChild(badge);

  const subtitle = document.createElement('div');
  subtitle.textContent = `User has ${data.recordAccess.maxAccessLevel || 'No'} access to this record`;
  subtitle.style.marginTop = '8px';
  subtitle.style.fontSize = '12px';
  subtitle.style.color = PD_COLORS.text;
  card.appendChild(subtitle);

  return card;
}

function buildRecordAccessSection(data) {
  const section = createSection('🔐 Record-Level Access');
  const { hasRead, hasEdit, hasDelete, hasTransfer } = data.recordAccess;

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(4, 1fr)';
  grid.style.gap = '8px';

  grid.appendChild(boolBadge('Read', hasRead));
  grid.appendChild(boolBadge('Edit', hasEdit));
  grid.appendChild(boolBadge('Delete', hasDelete));
  grid.appendChild(boolBadge('Transfer', hasTransfer));

  section.appendChild(grid);

  if (!hasRead) {
    section.appendChild(
      pdWarningBox(
        'This user cannot see this record at all due to sharing rules, OWD, or role hierarchy.',
        'error'
      )
    );
  }

  return section;
}

function buildFlsSection(data) {
  const section = createSection('🛡️ Field-Level Security');
  const notPermissionable = data.fieldMeta && data.fieldMeta.permissionable === false;

  if (!data.fls.length) {
    if (notPermissionable) {
      section.appendChild(
        pdWarningBox(
          'This field is not Field-Level-Security-controlled (e.g. a required standard field) — it is accessible whenever object and record access allow.',
          'info'
        )
      );
    } else {
      section.appendChild(
        pdWarningBox(
          'No FieldPermissions found — this field may be hidden by default or the user has no access.',
          'warning'
        )
      );
    }
    return section;
  }

  const sorted = [...data.fls].sort((a, b) =>
    a.source === b.source ? 0 : a.source === 'Profile' ? -1 : 1
  );

  const rows = sorted.map((f) => [
    `${f.source}: ${f.sourceName}`,
    createBadge(f.read ? '✅' : '❌', f.read ? 'success' : 'error'),
    createBadge(f.edit ? '✅' : '❌', f.edit ? 'success' : 'error')
  ]);

  section.appendChild(createTable(['Source', 'Read', 'Edit'], rows));
  return section;
}

function buildObjectCrudSection(data) {
  const section = createSection('📦 Object Permissions');

  if (!data.objectCrud.length) {
    section.appendChild(
      pdWarningBox('User has no explicit object permissions — check Profile.', 'warning')
    );
    return section;
  }

  const rows = data.objectCrud.map((o) => [
    `${o.source}: ${o.sourceName}`,
    createBadge(o.read ? '✅' : '❌', o.read ? 'success' : 'error'),
    createBadge(o.edit ? '✅' : '❌', o.edit ? 'success' : 'error'),
    createBadge(o.delete ? '✅' : '❌', o.delete ? 'success' : 'error')
  ]);

  section.appendChild(createTable(['Source', 'Read', 'Edit', 'Delete'], rows));
  return section;
}

function buildChainSection(data) {
  const section = createSection('⛓️ Permission Chain');
  section.appendChild(formatPermissionChain(data));
  return section;
}

function buildRawDataSection(data) {
  const section = createSection('');
  section.querySelector('h4').remove();

  const details = document.createElement('details');
  details.style.marginTop = '18px';
  details.style.fontFamily = PD_FONT;

  const summary = document.createElement('summary');
  summary.textContent = '📝 Raw API Response';
  summary.style.cursor = 'pointer';
  summary.style.fontSize = '13px';
  summary.style.fontWeight = '700';
  summary.style.color = PD_COLORS.text;
  details.appendChild(summary);

  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(data, null, 2);
  pre.style.background = PD_COLORS.background;
  pre.style.border = `1px solid ${PD_COLORS.border}`;
  pre.style.borderRadius = '4px';
  pre.style.padding = '10px';
  pre.style.fontSize = '11px';
  pre.style.overflowX = 'auto';
  pre.style.marginTop = '8px';
  details.appendChild(pre);

  section.appendChild(details);
  return section;
}

function buildCopyDebugButton(data) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '📋 Copy Debug Info';
  btn.style.marginTop = '18px';
  btn.style.width = '100%';
  btn.style.padding = '8px 12px';
  btn.style.background = '#fff';
  btn.style.color = PD_COLORS.info;
  btn.style.border = `1px solid ${PD_COLORS.info}`;
  btn.style.borderRadius = '4px';
  btn.style.fontFamily = PD_FONT;
  btn.style.fontWeight = '600';
  btn.style.cursor = 'pointer';

  btn.addEventListener('click', () => {
    const text = buildCopyDebugText(data);
    navigator.clipboard
      .writeText(text)
      .then(() => {
        const original = btn.textContent;
        btn.textContent = '✅ Copied!';
        setTimeout(() => {
          btn.textContent = original;
        }, 1500);
      })
      .catch((err) => {
        console.error('[Permission Detective] Failed to copy debug info', err);
      });
  });

  return btn;
}

// ---------- entry point ----------

function renderResults(data) {
  const resultsEl = document.getElementById('pd-results');
  if (!resultsEl) return;

  while (resultsEl.firstChild) {
    resultsEl.removeChild(resultsEl.firstChild);
  }

  resultsEl.style.opacity = '0';
  resultsEl.style.transition = 'opacity 0.3s ease-in';
  resultsEl.style.display = 'block';

  resultsEl.appendChild(buildSummaryCard(data));
  resultsEl.appendChild(buildRecordAccessSection(data));
  resultsEl.appendChild(buildFlsSection(data));
  resultsEl.appendChild(buildObjectCrudSection(data));
  resultsEl.appendChild(buildChainSection(data));
  resultsEl.appendChild(buildRawDataSection(data));
  resultsEl.appendChild(buildCopyDebugButton(data));

  requestAnimationFrame(() => {
    resultsEl.style.opacity = '1';
  });
}

window.renderResults = renderResults;
