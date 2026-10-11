const assert = require('assert');
function isAllowedRedirect(allowedList, redirectUrl) {
  if (!redirectUrl || typeof redirectUrl !== 'string') return false;
  try {
    const u = new URL(redirectUrl);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return allowedList.some((pattern) => {
      const p = pattern.trim();
      if (!p) return false;
      if (p.includes('chromiumapp.org')) {
        return host.endsWith('.chromiumapp.org') && host.split('.').length === 3;
      }
      if (p.includes('extensions.allizom.org')) {
        return host.endsWith('.extensions.allizom.org') && host.split('.').length === 4;
      }
      try {
        const pu = new URL(p);
        if (pu.protocol !== 'https:') return false;
        return pu.hostname.toLowerCase() === host;
      } catch (_) {
        const base = p.replace(/^https:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
        return host === base;
      }
    });
  } catch (_) {
    return false;
  }
}
const allowed = [
  'https://<chrome-id>.chromiumapp.org/',
  'https://<hash>.extensions.allizom.org/',
];
assert.strictEqual(isAllowedRedirect(allowed, 'https://a1b2c3d4e5f6g7h8.chromiumapp.org/'), true);
assert.strictEqual(isAllowedRedirect(allowed, 'https://deadbeef12345678.extensions.allizom.org/'), true);
assert.strictEqual(isAllowedRedirect(allowed, 'https://evil.example/chrome'), false);
assert.strictEqual(isAllowedRedirect(allowed, 'https://chromiumapp.org.evil.example/'), false);
console.log('worker allowlist tests passed');
