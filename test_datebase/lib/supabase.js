const DEFAULT_REFRESH_SECONDS = 60 * 60 * 24 * 30;

class SupabaseError extends Error {
  constructor(message, status = 502, code = 'SUPABASE_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function clean(value) {
  return String(value || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index < 0) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return cookies;
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
    return cookies;
  }, {});
}

function createSupabaseClient(options = {}) {
  const url = clean(options.url).replace(/\/$/, '');
  const key = clean(options.key);
  const secureCookies = Boolean(options.secureCookies);
  const configured = Boolean(url && key && !/^(your-|replace-|changeme|example)/i.test(key));

  function cookie(name, value, maxAge) {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAge))}`];
    if (secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  function setSessionCookies(res, session) {
    res.setHeader('Set-Cookie', [
      cookie('brickscout_access', session.access_token, Number(session.expires_in || 3600)),
      cookie('brickscout_refresh', session.refresh_token, DEFAULT_REFRESH_SECONDS),
    ]);
  }

  function clearSessionCookies(res) {
    res.setHeader('Set-Cookie', [cookie('brickscout_access', '', 0), cookie('brickscout_refresh', '', 0)]);
  }

  async function request(apiPath, { method = 'GET', token, body, headers = {} } = {}) {
    if (!configured) throw new SupabaseError('Supabase is not configured. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to .env.', 503, 'SUPABASE_NOT_CONFIGURED');
    const requestHeaders = { apikey: key, ...headers };
    if (token) requestHeaders.authorization = `Bearer ${token}`;
    if (body !== undefined) requestHeaders['content-type'] = 'application/json';
    let response;
    try {
      response = await fetch(`${url}${apiPath}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new SupabaseError('Could not connect to Supabase.', 502, 'SUPABASE_UNREACHABLE');
    }
    const raw = await response.text();
    let data = null;
    if (raw) { try { data = JSON.parse(raw); } catch { data = raw; } }
    if (!response.ok) {
      const message = data?.msg || data?.message || data?.error_description || data?.error || `Supabase request failed (${response.status}).`;
      const code = data?.code || data?.error_code || (response.status === 401 ? 'UNAUTHORIZED' : 'SUPABASE_REQUEST_FAILED');
      throw new SupabaseError(message, response.status, code);
    }
    return data;
  }

  async function getUser(accessToken) {
    return request('/auth/v1/user', { token: accessToken });
  }

  async function authenticate(req, res) {
    if (!configured) throw new SupabaseError('Supabase is not configured.', 503, 'SUPABASE_NOT_CONFIGURED');
    const cookies = parseCookies(req.headers.cookie);
    const accessToken = cookies.brickscout_access;
    const refreshToken = cookies.brickscout_refresh;
    if (accessToken) {
      try { return { user: await getUser(accessToken), accessToken }; }
      catch (error) { if (error.status !== 401) throw error; }
    }
    if (refreshToken) {
      try {
        const session = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } });
        setSessionCookies(res, session);
        return { user: session.user || await getUser(session.access_token), accessToken: session.access_token };
      } catch (error) {
        clearSessionCookies(res);
        if (error.status !== 400 && error.status !== 401) throw error;
      }
    }
    throw new SupabaseError('Sign in to continue.', 401, 'AUTH_REQUIRED');
  }

  return { configured, request, authenticate, setSessionCookies, clearSessionCookies };
}

module.exports = { createSupabaseClient, SupabaseError };
