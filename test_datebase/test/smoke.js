const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const nativeFetch = global.fetch;
const port = 3193;
process.env.PORT = String(port);
process.env.SUPABASE_URL = 'https://brickscout-test.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.COOKIE_SECURE = 'false';
process.env.EBAY_ENVIRONMENT = 'production';
process.env.EBAY_CLIENT_ID = 'test-client-id';
process.env.EBAY_CLIENT_SECRET = 'test-client-secret';
process.env.RENDER_EXTERNAL_HOSTNAME = 'brickscout-test.example';
process.env.EBAY_DELETION_VERIFICATION_TOKEN = 'test_verification_token_1234567890';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const user = { id: '11111111-1111-4111-8111-111111111111', email: 'builder@example.com', created_at: '2026-10-21T00:00:00Z' };
const profile = { user_id: user.id, display_name: 'Builder', location: null, favorite_theme: null };
const tables = { profiles: [profile], saved_deals: [], watchlists: [], transactions: [] };
let sequence = 1;

function json(data, status = 200, headers = {}) {
  return new Response(data == null ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.href === 'https://api.ebay.com/identity/v1/oauth2/token') {
    return json({ access_token: 'ebay-access-test', expires_in: 7200 });
  }
  if (url.href === 'https://api.ebay.com/commerce/notification/v1/public_key/test-key') {
    return json({ key: publicKey.export({ type: 'spki', format: 'pem' }) });
  }
  if (url.origin !== 'https://brickscout-test.supabase.co') return nativeFetch(input, options);
  const body = options.body ? JSON.parse(options.body) : null;
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    return json({ access_token: 'access-test', refresh_token: 'refresh-test', expires_in: 3600, user });
  }
  if (url.pathname === '/auth/v1/user') {
    return options.headers.authorization === 'Bearer access-test' ? json(user) : json({ message: 'invalid token' }, 401);
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    const table = url.pathname.split('/').pop();
    if (!tables[table]) return json({ message: 'missing table' }, 404);
    const method = options.method || 'GET';
    if (method === 'GET') return json(tables[table]);
    if (method === 'POST') {
      if (table === 'profiles') {
        Object.assign(profile, body);
        return json([profile], 201);
      }
      const record = { id: `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`, ...body, saved_at: '2026-10-21T00:00:00Z', created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z' };
      tables[table].push(record);
      return json([record], 201);
    }
    const id = url.searchParams.get('id')?.replace(/^eq\./, '');
    const index = tables[table].findIndex((record) => record.id === id);
    if (method === 'PATCH') {
      Object.assign(tables[table][index], body);
      return json([tables[table][index]]);
    }
    if (method === 'DELETE') {
      if (index >= 0) tables[table].splice(index, 1);
      return new Response(null, { status: 204 });
    }
  }
  if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
  return json({ message: 'unhandled mock request' }, 500);
};

require('../server');

async function run() {
  await new Promise((resolve) => setTimeout(resolve, 150));
  const origin = `http://127.0.0.1:${port}`;
  const healthResponse = await nativeFetch(`${origin}/api/health`);
  const health = await healthResponse.json();
  assert.equal(health.databaseConfigured, true);
  assert.equal(health.deletionNotificationsConfigured, true);

  const challengeCode = 'challenge-123';
  const challengeResponse = await nativeFetch(`${origin}/api/ebay/account-deletion?challenge_code=${challengeCode}`);
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  const expectedChallenge = crypto.createHash('sha256')
    .update(challengeCode)
    .update(process.env.EBAY_DELETION_VERIFICATION_TOKEN)
    .update(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}/api/ebay/account-deletion`)
    .digest('hex');
  assert.equal(challenge.challengeResponse, expectedChallenge);

  const deletionPayload = {
    metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION', schemaVersion: '1.0', deprecated: false },
    notification: {
      notificationId: '00000000-0000-4000-8000-000000000099',
      eventDate: '2026-10-21T00:00:00Z',
      publishDate: '2026-10-21T00:00:01Z',
      publishAttemptCount: 1,
      data: { username: 'test-user', userId: 'test-user-id', eiasToken: 'test-token' },
    },
  };
  const deletionSignature = crypto.sign('ssl3-sha1', Buffer.from(JSON.stringify(deletionPayload)), privateKey).toString('base64');
  const signatureHeader = Buffer.from(JSON.stringify({ kid: 'test-key', signature: deletionSignature })).toString('base64');
  const deletionResponse = await nativeFetch(`${origin}/api/ebay/account-deletion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ebay-signature': signatureHeader },
    body: JSON.stringify(deletionPayload),
  });
  assert.equal(deletionResponse.status, 204);

  const deniedResponse = await nativeFetch(`${origin}/api/dashboard`);
  assert.equal(deniedResponse.status, 401);

  const loginResponse = await nativeFetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: 'password123' }),
  });
  assert.equal(loginResponse.status, 200);
  const setCookies = loginResponse.headers.getSetCookie();
  assert.ok(setCookies.some((value) => value.includes('HttpOnly')));
  const cookie = setCookies.map((value) => value.split(';')[0]).join('; ');

  const saveResponse = await nativeFetch(`${origin}/api/saved-deals`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ ebayItemId: 'v1|123|0', title: 'LEGO Test Set', listingUrl: 'https://www.ebay.com/itm/123', priceCents: 6999, shippingCents: 0, currency: 'USD', condition: 'New' }),
  });
  assert.equal(saveResponse.status, 201);

  const dashboardResponse = await nativeFetch(`${origin}/api/dashboard`, { headers: { cookie } });
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.profile.display_name, 'Builder');
  assert.equal(dashboard.savedDeals.length, 1);
  assert.equal(dashboard.savedDeals[0].price_cents, 6999);

  const pageResponse = await nativeFetch(origin);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Saved deals/);
  console.log('Smoke test passed: eBay webhook, session cookies, protected dashboard, saved deals, and UI shell.');
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
