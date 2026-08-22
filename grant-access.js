// Permission Detective — runtime permission grant page.
// chrome.permissions.request() must be called from an extension page during a
// real user gesture; it cannot be called from the service worker or a content
// script. This page exists purely to provide that gesture.

const REQUIRED_ORIGINS = [
  'https://*.my.salesforce.com/*',
  'https://*.salesforce.com/*',
  'https://*.lightning.force.com/*'
];

const statusEl = document.getElementById('status');

function showStatus(message, isOk) {
  statusEl.textContent = message;
  statusEl.className = isOk ? 'ok' : 'err';
  statusEl.style.display = 'block';
}

async function refreshState() {
  try {
    const granted = await chrome.permissions.contains({ origins: REQUIRED_ORIGINS });
    if (granted) {
      showStatus('✓ Access already granted. Reload your Salesforce tab and click Analyze again.', true);
    }
  } catch (err) {
    console.warn('[Permission Detective] permission check failed', err);
  }
}

document.getElementById('grant').addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request({ origins: REQUIRED_ORIGINS });
    if (granted) {
      showStatus(
        '✓ Access granted. Now reload your Salesforce tab and click Analyze again — it should work.',
        true
      );
    } else {
      showStatus(
        'Access was declined. Permission Detective cannot read the Salesforce API session without it.',
        false
      );
    }
  } catch (err) {
    showStatus(`Could not request access: ${err.message}`, false);
  }
});

refreshState();
