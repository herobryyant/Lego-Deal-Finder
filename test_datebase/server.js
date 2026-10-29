const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSupabaseClient } = require('./lib/supabase');
const { median, toListing } = require("./lib/deals");

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = cleanEnv(process.env.EBAY_CLIENT_ID);
const CLIENT_SECRET = cleanEnv(process.env.EBAY_CLIENT_SECRET);
const MARKETPLACE = cleanEnv(process.env.EBAY_MARKETPLACE_ID) || 'EBAY_US';
const EBAY_ENVIRONMENT = cleanEnv(process.env.EBAY_ENVIRONMENT || 'production').toLowerCase();
const IS_SANDBOX = EBAY_ENVIRONMENT === 'sandbox';
const EBAY_API_ORIGIN = IS_SANDBOX ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
const EBAY_DELETION_PATH = '/api/ebay/account-deletion';
const RENDER_EXTERNAL_HOSTNAME = cleanEnv(process.env.RENDER_EXTERNAL_HOSTNAME);
const EBAY_DELETION_ENDPOINT = cleanEnv(process.env.EBAY_DELETION_ENDPOINT)
  || (RENDER_EXTERNAL_HOSTNAME ? `https://${RENDER_EXTERNAL_HOSTNAME}${EBAY_DELETION_PATH}` : '');
const EBAY_DELETION_VERIFICATION_TOKEN = cleanEnv(process.env.EBAY_DELETION_VERIFICATION_TOKEN);
const PUBLIC_DIR = path.join(__dirname, 'public');
const supabase = createSupabaseClient({
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY,
  secureCookies: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
});
let tokenCache = { value: null, expiresAt: 0 };
const notificationPublicKeys = new Map();

if (!['production', 'sandbox'].includes(EBAY_ENVIRONMENT)) {
  console.error('EBAY_ENVIRONMENT must be either "production" or "sandbox".');
  process.exit(1);
}

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function cleanEnv(value) {
  return String(value || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

function credentialsConfigured() {
  const placeholders = /^(your-|replace-|changeme|example)/i;
  return Boolean(CLIENT_ID && CLIENT_SECRET && !placeholders.test(CLIENT_ID) && !placeholders.test(CLIENT_SECRET));
}

function isDeletionPath(pathname) {
  return String(pathname || '').replace(/\/+$/, '') === EBAY_DELETION_PATH;
}

function deletionNotificationsConfigured() {
  if (!/^[A-Za-z0-9_-]{32,80}$/.test(EBAY_DELETION_VERIFICATION_TOKEN)) return false;
  try {
    const endpoint = new URL(EBAY_DELETION_ENDPOINT);
    return endpoint.protocol === 'https:' && isDeletionPath(endpoint.pathname);
  } catch {
    return false;
  }
}

function authenticationHelp() {
  const selected = IS_SANDBOX ? 'Sandbox' : 'Production';
  const disabledHelp = IS_SANDBOX ? '' : ' Also confirm the Production keyset is enabled and its Marketplace Account Deletion/Closure requirement is complete.';
  return `eBay rejected the ${selected} credentials. Copy the App ID into EBAY_CLIENT_ID and the Cert ID into EBAY_CLIENT_SECRET from the same ${selected} keyset.${disabledHelp}`;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let rejected = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (rejected) return;
      body += chunk;
      if (body.length > limit) {
        rejected = true;
        reject(Object.assign(new Error('Request body is too large.'), { status: 413, code: 'BODY_TOO_LARGE' }));
      }
    });
    req.on('end', () => {
      if (rejected) return;
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400, code: 'INVALID_JSON' })); }
    });
    req.on('error', reject);
  });
}

function sendNoContent(res, status = 204) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end();
}

function text(value, max, field, required = false) {
  const result = String(value ?? '').trim();
  if (required && !result) throw Object.assign(new Error(`${field} is required.`), { status: 400, code: 'VALIDATION_ERROR' });
  if (result.length > max) throw Object.assign(new Error(`${field} must be ${max} characters or fewer.`), { status: 400, code: 'VALIDATION_ERROR' });
  return result || null;
}

function cents(value, field, required = false) {
  if ((value === '' || value == null) && !required) return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw Object.assign(new Error(`${field} must be a non-negative whole number of cents.`), { status: 400, code: 'VALIDATION_ERROR' });
  return result;
}

function safeUser(user) {
  return { id: user.id, email: user.email, createdAt: user.created_at };
}

async function getAppToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${EBAY_API_ORIGIN}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const rejected = response.status === 401 || data.error === 'invalid_client' || /authentication failed/i.test(data.error_description || '');
    const error = new Error(rejected ? authenticationHelp() : (data.error_description || data.error || 'Could not get an eBay access token.'));
    error.code = rejected ? 'EBAY_AUTH_REJECTED' : 'EBAY_TOKEN_ERROR';
    error.status = 502;
    throw error;
  }
  tokenCache = { value: data.access_token, expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 7200) - 120) * 1000 };
  return tokenCache.value;
}

function createDeletionChallengeResponse(challengeCode) {
  return crypto
    .createHash('sha256')
    .update(challengeCode)
    .update(EBAY_DELETION_VERIFICATION_TOKEN)
    .update(EBAY_DELETION_ENDPOINT)
    .digest('hex');
}

function decodeNotificationSignature(value) {
  try {
    const decoded = JSON.parse(Buffer.from(String(value || ''), 'base64').toString('ascii'));
    if (!decoded.kid || !decoded.signature) throw new Error('Signature fields are missing.');
    return decoded;
  } catch {
    throw Object.assign(new Error('The eBay notification signature is missing or invalid.'), {
      status: 412,
      code: 'INVALID_EBAY_SIGNATURE',
    });
  }
}

function formatNotificationPublicKey(value) {
  const key = String(value || '').trim();
  if (!key) throw new Error('eBay returned an empty notification public key.');
  if (!key.includes('-----BEGIN PUBLIC KEY-----')) return key;
  return key
    .replace(/-----BEGIN PUBLIC KEY-----\s*/, '-----BEGIN PUBLIC KEY-----\n')
    .replace(/\s*-----END PUBLIC KEY-----/, '\n-----END PUBLIC KEY-----');
}

async function getNotificationPublicKey(keyId) {
  const cached = notificationPublicKeys.get(keyId);
  if (cached && Date.now() < cached.expiresAt) return cached.key;

  const token = await getAppToken();
  const response = await fetch(`${EBAY_API_ORIGIN}/commerce/notification/v1/public_key/${encodeURIComponent(keyId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.key) {
    const error = new Error(data.errors?.[0]?.message || 'Could not retrieve the eBay notification public key.');
    error.status = 502;
    error.code = 'EBAY_PUBLIC_KEY_ERROR';
    throw error;
  }

  const key = formatNotificationPublicKey(data.key);
  notificationPublicKeys.set(keyId, { key, expiresAt: Date.now() + 60 * 60 * 1000 });
  return key;
}

async function verifyDeletionNotification(message, signatureHeader) {
  const signature = decodeNotificationSignature(signatureHeader);
  const publicKey = await getNotificationPublicKey(signature.kid);
  const verifier = crypto.createVerify('ssl3-sha1');
  verifier.update(JSON.stringify(message));
  verifier.end();
  return verifier.verify(publicKey, signature.signature, 'base64');
}

async function processDeletionNotification(message) {
  // The current schema stores listing details, but no eBay username, immutable
  // user ID, or EIAS token. There is therefore no account-linked eBay personal
  // data to remove. Add idempotent deletion/anonymization here before persisting
  // any of those identifiers in the future.
  console.info(`Acknowledged eBay account deletion notification ${message.notification.notificationId}.`);
}

async function handleDeletionNotification(req, res, url) {
  if (!isDeletionPath(url.pathname)) return false;

  if (!deletionNotificationsConfigured()) {
    return sendJson(res, 503, {
      error: 'The eBay account deletion endpoint is not configured.',
      code: 'EBAY_DELETION_NOT_CONFIGURED',
    });
  }

  if (req.method === 'GET') {
    const challengeCode = (url.searchParams.get('challenge_code') || '').trim();
    if (!challengeCode) return sendJson(res, 400, { error: 'challenge_code is required.', code: 'MISSING_CHALLENGE_CODE' });
    return sendJson(res, 200, { challengeResponse: createDeletionChallengeResponse(challengeCode) });
  }

  if (req.method === 'POST') {
    const message = await readJson(req, 256 * 1024);
    if (message?.metadata?.topic !== 'MARKETPLACE_ACCOUNT_DELETION' || !message?.notification?.notificationId) {
      return sendJson(res, 400, { error: 'Unexpected eBay notification payload.', code: 'INVALID_EBAY_NOTIFICATION' });
    }
    if (!await verifyDeletionNotification(message, req.headers['x-ebay-signature'])) {
      return sendJson(res, 412, { error: 'The eBay notification signature could not be verified.', code: 'INVALID_EBAY_SIGNATURE' });
    }
    await processDeletionNotification(message);
    return sendNoContent(res);
  }

  res.writeHead(405, { allow: 'GET, POST' });
  res.end('Method not allowed');
  return true;
}

async function searchEbay(query, setNumber) {
  const token = await getAppToken();
  const fullQuery = setNumber ? `LEGO ${setNumber}` : `LEGO ${query}`;
  const params = new URLSearchParams({ q: fullQuery, limit: '50', sort: 'price' });
  const response = await fetch(`${EBAY_API_ORIGIN}/buy/browse/v1/item_summary/search?${params}`, {
    headers: {
      authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
      'X-EBAY-C-ENDUSERCTX': 'contextualLocation=country=US',
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.errors?.[0]?.message || data.error_description || 'The eBay search request failed.');
    error.status = response.status === 429 ? 503 : 502;
    throw error;
  }
  const listings = (data.itemSummaries || []).map(toListing).filter(Boolean);
  const baseline = median(listings.map((listing) => listing.total));
  return {
    query: fullQuery,
    count: Number(data.total || listings.length),
    returned: listings.length,
    medianTotal: baseline,
    listings: listings.map((listing) => ({
      ...listing,
      discountPercent: baseline && baseline > 0 ? Math.round((1 - listing.total / baseline) * 100) : 0,
    })),
  };
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, requested);
  if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(resolved, (error, content) => {
    if (error) { res.writeHead(404); return res.end('Not found'); }
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[path.extname(resolved)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(content);
  });
}

async function restTable(table, accessToken, { method = 'GET', query = '', body, prefer } = {}) {
  const headers = {};
  if (prefer) headers.Prefer = prefer;
  return supabase.request(`/rest/v1/${table}${query}`, { method, token: accessToken, body, headers });
}

async function profileFor(userId, accessToken) {
  const rows = await restTable('profiles', accessToken, { query: `?user_id=eq.${encodeURIComponent(userId)}&select=*` });
  return rows?.[0] || null;
}

async function dashboardFor(userId, accessToken) {
  const [profile, savedDeals, watchlists, transactions] = await Promise.all([
    profileFor(userId, accessToken),
    restTable('saved_deals', accessToken, { query: '?select=*&order=saved_at.desc' }),
    restTable('watchlists', accessToken, { query: '?select=*&order=updated_at.desc' }),
    restTable('transactions', accessToken, { query: '?select=*&order=occurred_at.desc,created_at.desc' }),
  ]);
  return { profile, savedDeals, watchlists, transactions };
}

async function handleAuth(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/auth/session') {
    if (!supabase.configured) return sendJson(res, 200, { configured: false, user: null });
    try {
      const session = await supabase.authenticate(req, res);
      return sendJson(res, 200, { configured: true, user: safeUser(session.user), profile: await profileFor(session.user.id, session.accessToken) });
    } catch (error) {
      if (error.status === 401) return sendJson(res, 200, { configured: true, user: null });
      throw error;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
    const body = await readJson(req);
    const email = text(body.email, 254, 'Email', true)?.toLowerCase();
    const password = String(body.password || '');
    const displayName = text(body.displayName, 80, 'Display name', true);
    if (!/^\S+@\S+\.\S+$/.test(email)) throw Object.assign(new Error('Enter a valid email address.'), { status: 400, code: 'VALIDATION_ERROR' });
    if (password.length < 8 || password.length > 128) throw Object.assign(new Error('Password must contain 8 to 128 characters.'), { status: 400, code: 'VALIDATION_ERROR' });
    const data = await supabase.request('/auth/v1/signup', { method: 'POST', body: { email, password, data: { display_name: displayName } } });
    if (data.access_token && data.refresh_token) supabase.setSessionCookies(res, data);
    return sendJson(res, 201, {
      user: data.user ? safeUser(data.user) : null,
      requiresEmailConfirmation: !data.access_token,
      message: data.access_token ? 'Account created.' : 'Check your email to confirm your account, then sign in.',
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(req);
    const email = text(body.email, 254, 'Email', true)?.toLowerCase();
    const password = String(body.password || '');
    const data = await supabase.request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    supabase.setSessionCookies(res, data);
    return sendJson(res, 200, { user: safeUser(data.user), profile: await profileFor(data.user.id, data.access_token) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    try {
      const session = await supabase.authenticate(req, res);
      await supabase.request('/auth/v1/logout?scope=local', { method: 'POST', token: session.accessToken });
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    supabase.clearSessionCookies(res);
    return sendJson(res, 200, { ok: true });
  }
  return false;
}

async function handleUserData(req, res, url) {
  const session = await supabase.authenticate(req, res);
  const userId = session.user.id;
  const token = session.accessToken;

  if (req.method === 'GET' && url.pathname === '/api/dashboard') return sendJson(res, 200, await dashboardFor(userId, token));

  if (req.method === 'PUT' && url.pathname === '/api/profile') {
    const body = await readJson(req);
    const record = {
      user_id: userId,
      display_name: text(body.displayName, 80, 'Display name'),
      location: text(body.location, 120, 'Location'),
      favorite_theme: text(body.favoriteTheme, 80, 'Favorite theme'),
    };
    const rows = await restTable('profiles', token, {
      method: 'POST', query: '?on_conflict=user_id', body: record,
      prefer: 'resolution=merge-duplicates,return=representation',
    });
    return sendJson(res, 200, { profile: rows?.[0] || record });
  }

  if (req.method === 'POST' && url.pathname === '/api/saved-deals') {
    const body = await readJson(req);
    const record = {
      user_id: userId,
      ebay_item_id: text(body.ebayItemId, 200, 'eBay item ID', true),
      title: text(body.title, 300, 'Title', true),
      listing_url: text(body.listingUrl, 2000, 'Listing URL', true),
      image_url: text(body.imageUrl, 2000, 'Image URL'),
      price_cents: cents(body.priceCents, 'Price', true),
      shipping_cents: cents(body.shippingCents, 'Shipping'),
      currency: (text(body.currency, 3, 'Currency') || 'USD').toUpperCase(),
      item_condition: text(body.condition, 120, 'Condition'),
    };
    if (!/^https:\/\//i.test(record.listing_url)) throw Object.assign(new Error('Listing URL must use HTTPS.'), { status: 400, code: 'VALIDATION_ERROR' });
    const rows = await restTable('saved_deals', token, {
      method: 'POST', query: '?on_conflict=user_id,ebay_item_id', body: record,
      prefer: 'resolution=merge-duplicates,return=representation',
    });
    return sendJson(res, 201, { savedDeal: rows?.[0] });
  }

  const savedMatch = url.pathname.match(/^\/api\/saved-deals\/([0-9a-f-]+)$/i);
  if (req.method === 'DELETE' && savedMatch) {
    await restTable('saved_deals', token, { method: 'DELETE', query: `?id=eq.${encodeURIComponent(savedMatch[1])}` });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/watchlists') {
    const body = await readJson(req);
    const record = {
      user_id: userId,
      name: text(body.name, 100, 'Watchlist name', true),
      search_query: text(body.searchQuery, 150, 'Search query', true),
      set_number: text(body.setNumber, 30, 'Set number'),
      max_price_cents: cents(body.maxPriceCents, 'Maximum price'),
      active: body.active !== false,
    };
    const rows = await restTable('watchlists', token, { method: 'POST', body: record, prefer: 'return=representation' });
    return sendJson(res, 201, { watchlist: rows?.[0] });
  }

  const watchMatch = url.pathname.match(/^\/api\/watchlists\/([0-9a-f-]+)$/i);
  if (watchMatch && req.method === 'PATCH') {
    const body = await readJson(req);
    const changes = {};
    if ('name' in body) changes.name = text(body.name, 100, 'Watchlist name', true);
    if ('searchQuery' in body) changes.search_query = text(body.searchQuery, 150, 'Search query', true);
    if ('setNumber' in body) changes.set_number = text(body.setNumber, 30, 'Set number');
    if ('maxPriceCents' in body) changes.max_price_cents = cents(body.maxPriceCents, 'Maximum price');
    if ('active' in body) changes.active = Boolean(body.active);
    const rows = await restTable('watchlists', token, { method: 'PATCH', query: `?id=eq.${encodeURIComponent(watchMatch[1])}`, body: changes, prefer: 'return=representation' });
    return sendJson(res, 200, { watchlist: rows?.[0] });
  }
  if (watchMatch && req.method === 'DELETE') {
    await restTable('watchlists', token, { method: 'DELETE', query: `?id=eq.${encodeURIComponent(watchMatch[1])}` });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/transactions') {
    const body = await readJson(req);
    const allowed = new Set(['planned', 'purchased', 'sold', 'cancelled']);
    const status = text(body.status, 20, 'Status', true);
    if (!allowed.has(status)) throw Object.assign(new Error('Transaction status is invalid.'), { status: 400, code: 'VALIDATION_ERROR' });
    const record = {
      user_id: userId,
      ebay_item_id: text(body.ebayItemId, 200, 'eBay item ID'),
      title: text(body.title, 300, 'Title', true),
      amount_cents: cents(body.amountCents, 'Amount', true),
      currency: (text(body.currency, 3, 'Currency') || 'USD').toUpperCase(),
      status,
      occurred_at: /^\d{4}-\d{2}-\d{2}$/.test(body.occurredAt || '') ? body.occurredAt : new Date().toISOString().slice(0, 10),
      notes: text(body.notes, 1000, 'Notes'),
    };
    const rows = await restTable('transactions', token, { method: 'POST', body: record, prefer: 'return=representation' });
    return sendJson(res, 201, { transaction: rows?.[0] });
  }

  const transactionMatch = url.pathname.match(/^\/api\/transactions\/([0-9a-f-]+)$/i);
  if (transactionMatch && req.method === 'PATCH') {
    const body = await readJson(req);
    const allowed = new Set(['planned', 'purchased', 'sold', 'cancelled']);
    const changes = {};
    if ('status' in body) {
      const status = text(body.status, 20, 'Status', true);
      if (!allowed.has(status)) throw Object.assign(new Error('Transaction status is invalid.'), { status: 400, code: 'VALIDATION_ERROR' });
      changes.status = status;
    }
    if ('notes' in body) changes.notes = text(body.notes, 1000, 'Notes');
    const rows = await restTable('transactions', token, { method: 'PATCH', query: `?id=eq.${encodeURIComponent(transactionMatch[1])}`, body: changes, prefer: 'return=representation' });
    return sendJson(res, 200, { transaction: rows?.[0] });
  }
  if (transactionMatch && req.method === 'DELETE') {
    await restTable('transactions', token, { method: 'DELETE', query: `?id=eq.${encodeURIComponent(transactionMatch[1])}` });
    return sendJson(res, 200, { ok: true });
  }
  return false;
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      ebayConfigured: credentialsConfigured(),
      ebayEnvironment: EBAY_ENVIRONMENT,
      marketplace: MARKETPLACE,
      databaseConfigured: supabase.configured,
      deletionNotificationsConfigured: deletionNotificationsConfigured(),
    });
  }
  const deletionHandled = await handleDeletionNotification(req, res, url);
  if (deletionHandled !== false) return deletionHandled;
  if (req.method === 'GET' && url.pathname === '/api/search') {
    if (!credentialsConfigured()) return sendJson(res, 503, { error: 'Add an eBay App ID and Cert ID to .env to load live listings.', code: 'EBAY_NOT_CONFIGURED' });
    const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
    const setNumber = (url.searchParams.get('set') || '').trim().slice(0, 30);
    if (!query && !setNumber) return sendJson(res, 400, { error: 'Enter a LEGO set name or set number.' });
    return sendJson(res, 200, await searchEbay(query, setNumber));
  }
  const authHandled = await handleAuth(req, res, url);
  if (authHandled !== false) return authHandled;
  if (/^\/api\/(dashboard|profile|saved-deals|watchlists|transactions)(\/|$)/.test(url.pathname)) {
    const handled = await handleUserData(req, res, url);
    if (handled !== false) return handled;
  }
  return sendJson(res, 404, { error: 'API route not found.', code: 'NOT_FOUND' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    res.writeHead(405, { allow: 'GET' }); res.end('Method not allowed');
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error('Request failed:', error.message);
    if (!res.headersSent) sendJson(res, status, { error: error.message || 'Unexpected server error.', code: error.code || 'SERVER_ERROR' });
    else res.end();
  }
});

async function checkEbayAuthentication() {
  console.log(`Checking eBay ${EBAY_ENVIRONMENT} authentication...`);
  if (!credentialsConfigured()) { console.error('Missing eBay credentials.'); process.exitCode = 1; return; }
  try { await getAppToken(); console.log(`Success: the eBay ${EBAY_ENVIRONMENT} App ID and Cert ID are valid.`); }
  catch (error) { console.error(`Failed: ${error.message}`); process.exitCode = 1; }
}

if (process.argv.includes('--check-ebay-auth')) {
  checkEbayAuthentication();
} else {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`LEGO Deal Finder running at http://localhost:${PORT}`);
    console.log(`eBay environment: ${EBAY_ENVIRONMENT}`);
    console.log(`Supabase database: ${supabase.configured ? 'configured' : 'not configured'}`);
  });
}
