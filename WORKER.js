const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

function parseState(s) {
  try {
    const d = JSON.parse(atob(s));
    return Date.now() - d.t > 600000 ? null : d;
  } catch { return null; }
}

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowed = (env.ALLOWED_REDIRECTS || '').split(',').map((s) => s.trim()).filter(Boolean);

    if (url.pathname === '/callback' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const sd = state && parseState(state);
      const redirectUri = sd && sd.r;
      if (!code || !sd || !sd.n || !redirectUri || !isAllowedRedirect(allowed, redirectUri)) {
        return new Response('Bad request', { status: 400 });
      }
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: url.origin + '/callback',
        }),
      });
      const data = await res.json();
      const back = new URL(redirectUri);
      if (!data.access_token) {
        back.hash = 'error=' + encodeURIComponent(data.error_description || data.error || 'failed');
        return Response.redirect(back.toString(), 302);
      }
      const id = crypto.randomUUID();
      await env.TOKENS.put(id, JSON.stringify({ token: data.access_token, n: sd.n }), { expirationTtl: 120 });
      back.hash = 'token_id=' + id + '&state=' + encodeURIComponent(state);
      return Response.redirect(back.toString(), 302);
    }

    if (url.pathname === '/token' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const raw = await env.TOKENS.get(body.token_id || '');
      if (!raw) return json({ error: 'not found or used' }, 404);
      await env.TOKENS.delete(body.token_id);
      const e = JSON.parse(raw);
      if (e.n !== body.nonce) return json({ error: 'nonce mismatch' }, 403);
      return json({ access_token: e.token });
    }

    return new Response('Not found', { status: 404 });
  },
};
