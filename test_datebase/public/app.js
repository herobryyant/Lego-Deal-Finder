const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const form = $('#search-form');
const input = $('#search-input');
const statusArea = $('#status-area');
const resultsSection = $('#results-section');
const resultsGrid = $('#results-grid');
const emptyState = $('#empty-state');
const sortSelect = $('#sort-select');
const authDialog = $('#auth-dialog');
const accountDialog = $('#account-dialog');
const accountButton = $('#account-button');
let mode = 'name';
let authMode = 'login';
let latest = null;
let session = { configured: null, user: null, profile: null };
let dashboard = null;
let toastTimer = null;

function money(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
}

function dollarsToCents(value) {
  if (value === '' || value == null) return null;
  return Math.round(Number(value) * 100);
}

function localDateValue(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function api(url, options = {}) {
  const request = { ...options, headers: { ...(options.headers || {}) } };
  if (request.body && typeof request.body !== 'string') {
    request.headers['content-type'] = 'application/json';
    request.body = JSON.stringify(request.body);
  }
  const response = await fetch(url, request);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function setFormMessage(selector, message = '', success = false) {
  const element = $(selector);
  element.textContent = message;
  element.classList.toggle('success', success);
}

function setMode(nextMode) {
  mode = nextMode;
  $$('.tab').forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  input.placeholder = mode === 'number' ? 'Try ‘75375’' : 'Try ‘Star Wars Millennium Falcon’';
  input.setAttribute('aria-label', mode === 'number' ? 'LEGO set number' : 'LEGO set name');
  $('#input-hint').textContent = mode === 'number' ? 'Search by set number' : 'Search any LEGO set';
}

function showNotice(title, message, linkHtml = '') {
  statusArea.innerHTML = `<div class="notice"><strong>${title}</strong>${message}${linkHtml}</div>`;
}

function savedItemIds() {
  return new Set((dashboard?.savedDeals || []).map((deal) => deal.ebay_item_id));
}

function renderResults() {
  if (!latest) return;
  const saved = savedItemIds();
  const listings = [...latest.listings].sort((a, b) => {
    if (sortSelect.value === 'price') return a.total - b.total;
    if (sortSelect.value === 'discount') return b.discountPercent - a.discountPercent;
    return b.discountPercent - a.discountPercent || a.total - b.total;
  });
  resultsGrid.innerHTML = listings.map((item) => {
    const deal = item.discountPercent >= 10;
    const tag = deal ? `${item.discountPercent}% below median` : 'Near current median';
    const image = item.image ? `<img src="${escapeHtml(item.image)}" alt="" loading="lazy" onerror="this.remove()">` : '<span class="image-placeholder" aria-hidden="true">▧</span>';
    const location = item.location ? escapeHtml(item.location) : escapeHtml(item.condition);
    const originalIndex = latest.listings.findIndex((candidate) => candidate.id === item.id);
    const isSaved = saved.has(item.id);
    return `<article class="card">
      <div class="card-image">${image}<span class="deal-tag ${deal ? '' : 'neutral'}">${tag}</span><button class="save-deal-button ${isSaved ? 'saved' : ''}" type="button" data-save-index="${originalIndex}" aria-label="${isSaved ? 'Saved deal' : 'Save deal'}" title="${isSaved ? 'Saved' : 'Save deal'}">${isSaved ? '✓' : '♡'}</button></div>
      <div class="card-body">
        <h3 class="card-title">${escapeHtml(item.title)}</h3>
        <div class="card-meta"><span>${escapeHtml(item.condition)}</span><span>${location}</span></div>
        <div class="card-price-row"><div><div class="price">${money(item.total, item.currency)}</div><div class="price-detail">${money(item.price, item.currency)}${item.shippingKnown ? (item.shipping > 0 ? ` + ${money(item.shipping, item.currency)} ship` : ' · free shipping') : ' · shipping not listed'}</div></div><div class="card-actions"><a class="listing-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">View on eBay ↗</a></div></div>
      </div>
    </article>`;
  }).join('');
  resultsSection.hidden = false;
  emptyState.hidden = true;
  $('#results-title').textContent = latest.query;
  $('#results-subtitle').textContent = `${latest.count.toLocaleString()} matching listings · showing ${latest.returned}`;
  $('#market-note').textContent = latest.medianTotal == null ? 'No comparable prices were returned.' : `Current listing median: ${money(latest.medianTotal)} total, including shipping when available. “Below median” compares active results, not completed sales.`;
  $('#results-footer').textContent = 'Prices and availability can change. Check the listing details, seller, and shipping before buying.';
}

async function runSearch(rawValue) {
  const term = rawValue.trim();
  if (!term) { input.focus(); return; }
  input.value = term;
  statusArea.innerHTML = '<div class="loading"><div class="spinner"></div>Searching current eBay listings…</div>';
  resultsSection.hidden = true;
  emptyState.hidden = true;
  form.querySelector('button[type="submit"]').disabled = true;
  const param = mode === 'number' ? `set=${encodeURIComponent(term)}` : `q=${encodeURIComponent(term)}`;
  try {
    latest = await api(`/api/search?${param}`);
    statusArea.innerHTML = '';
    if (!latest.returned) {
      showNotice('No matching listings found', 'Try a shorter set name or double-check the set number.');
      emptyState.hidden = false;
      return;
    }
    renderResults();
  } catch (error) {
    if (error.code === 'EBAY_NOT_CONFIGURED') {
      const externalQuery = `LEGO ${term}`;
      const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(externalQuery)}`;
      showNotice('Connect eBay to load live results', `${escapeHtml(error.message)} Your search is ready to try directly on eBay.`, `<br><a href="${url}" target="_blank" rel="noopener noreferrer">Search “${escapeHtml(externalQuery)}” on eBay ↗</a>`);
    } else if (error.code === 'EBAY_AUTH_REJECTED') {
      showNotice('eBay rejected the credentials', `${escapeHtml(error.message)} Update .env, restart the server, and run npm run check:ebay.`);
    } else {
      showNotice('Couldn’t load listings', escapeHtml(error.message || 'Please try again in a moment.'));
    }
    emptyState.hidden = false;
  } finally {
    form.querySelector('button[type="submit"]').disabled = false;
  }
}

function updateAccountButton() {
  if (session.configured === false) accountButton.textContent = 'Accounts offline';
  else if (session.user) accountButton.textContent = session.profile?.display_name || 'My BrickScout';
  else accountButton.textContent = 'Sign in';
}

async function loadSession() {
  try {
    session = await api('/api/auth/session');
    updateAccountButton();
  } catch {
    session = { configured: false, user: null, profile: null };
    updateAccountButton();
  }
}

function setAuthMode(nextMode) {
  authMode = nextMode;
  $$('.modal-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.authMode === authMode));
  $('#display-name-field').hidden = authMode !== 'signup';
  $('#auth-display-name').required = authMode === 'signup';
  $('#auth-password').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
  $('#auth-title').textContent = authMode === 'signup' ? 'Create your account' : 'Welcome back';
  $('#auth-form .primary-button').textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
  setFormMessage('#auth-message');
}

function openAuth() {
  setAuthMode('login');
  if (!authDialog.open) authDialog.showModal();
}

async function loadDashboardData(showLoading = true) {
  if (showLoading) $('#account-loading').hidden = false;
  try {
    dashboard = await api('/api/dashboard');
    session.profile = dashboard.profile;
    updateAccountButton();
    renderDashboard();
  } finally {
    $('#account-loading').hidden = true;
  }
}

async function openAccount() {
  if (!accountDialog.open) accountDialog.showModal();
  $('#account-email').textContent = session.user.email;
  $('#account-name').textContent = session.profile?.display_name || 'My collection';
  setFormMessage('#account-message');
  try { await loadDashboardData(); }
  catch (error) { setFormMessage('#account-message', error.message); }
}

function renderDashboard() {
  if (!dashboard) return;
  const profile = dashboard.profile || {};
  $('#profile-display-name').value = profile.display_name || '';
  $('#profile-location').value = profile.location || '';
  $('#profile-theme').value = profile.favorite_theme || '';
  $('#account-name').textContent = profile.display_name || 'My collection';
  $('#saved-count').textContent = dashboard.savedDeals.length;
  $('#watchlist-count').textContent = dashboard.watchlists.length;
  $('#transaction-count').textContent = dashboard.transactions.length;

  $('#saved-deals-list').innerHTML = dashboard.savedDeals.length ? dashboard.savedDeals.map((deal) => `
    <article class="data-row"><div class="data-row-main"><h3>${escapeHtml(deal.title)}</h3><div class="data-row-meta"><span>${money((Number(deal.price_cents) + Number(deal.shipping_cents || 0)) / 100, deal.currency)}</span><span>${escapeHtml(deal.item_condition || 'Condition unavailable')}</span><span>Saved ${new Date(deal.saved_at).toLocaleDateString()}</span></div></div><div class="data-row-actions"><a class="small-button" href="${escapeHtml(deal.listing_url)}" target="_blank" rel="noopener noreferrer">View ↗</a><button class="small-button danger" type="button" data-delete-saved="${deal.id}">Remove</button></div></article>`).join('') : '<div class="data-empty">Save a listing from the search results and it will appear here.</div>';

  $('#watchlists-list').innerHTML = dashboard.watchlists.length ? dashboard.watchlists.map((watchlist) => `
    <article class="data-row"><div class="data-row-main"><h3>${escapeHtml(watchlist.name)}</h3><div class="data-row-meta"><span>${escapeHtml(watchlist.set_number || watchlist.search_query)}</span><span>${watchlist.max_price_cents == null ? 'Any price' : `Up to ${money(Number(watchlist.max_price_cents) / 100)}`}</span><span class="status-pill ${watchlist.active ? '' : 'cancelled'}">${watchlist.active ? 'Active' : 'Paused'}</span></div></div><div class="data-row-actions"><button class="small-button" type="button" data-run-watchlist="${watchlist.id}">Search</button><button class="small-button" type="button" data-toggle-watchlist="${watchlist.id}">${watchlist.active ? 'Pause' : 'Resume'}</button><button class="small-button danger" type="button" data-delete-watchlist="${watchlist.id}">Remove</button></div></article>`).join('') : '<div class="data-empty">Create a watchlist for a set or search you want to revisit.</div>';

  $('#transactions-list').innerHTML = dashboard.transactions.length ? dashboard.transactions.map((transaction) => `
    <article class="data-row"><div class="data-row-main"><h3>${escapeHtml(transaction.title)}</h3><div class="data-row-meta"><span>${money(Number(transaction.amount_cents) / 100, transaction.currency)}</span><span>${new Date(`${transaction.occurred_at}T12:00:00`).toLocaleDateString()}</span>${transaction.notes ? `<span>${escapeHtml(transaction.notes)}</span>` : ''}</div></div><div class="data-row-actions"><select class="small-button" data-transaction-status="${transaction.id}" aria-label="Transaction status"><option value="planned" ${transaction.status === 'planned' ? 'selected' : ''}>Planned</option><option value="purchased" ${transaction.status === 'purchased' ? 'selected' : ''}>Purchased</option><option value="sold" ${transaction.status === 'sold' ? 'selected' : ''}>Sold</option><option value="cancelled" ${transaction.status === 'cancelled' ? 'selected' : ''}>Cancelled</option></select><button class="small-button danger" type="button" data-delete-transaction="${transaction.id}">Remove</button></div></article>`).join('') : '<div class="data-empty">Record planned purchases, purchases, or sales to build your history.</div>';
}

async function saveListing(index, button) {
  if (!session.user) { openAuth(); return; }
  const item = latest?.listings[index];
  if (!item) return;
  button.disabled = true;
  try {
    await api('/api/saved-deals', {
      method: 'POST',
      body: {
        ebayItemId: item.id,
        title: item.title,
        listingUrl: item.url,
        imageUrl: item.image,
        priceCents: Math.round(item.price * 100),
        shippingCents: item.shippingKnown ? Math.round(item.shipping * 100) : null,
        currency: item.currency,
        condition: item.condition,
      },
    });
    await loadDashboardData(false);
    renderResults();
    showToast('Deal saved to your account.');
  } catch (error) {
    if (error.status === 401) { session.user = null; updateAccountButton(); openAuth(); }
    else showToast(error.message);
  } finally { button.disabled = false; }
}

$$('.tab').forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));
form.addEventListener('submit', (event) => { event.preventDefault(); runSearch(input.value); });
$$('[data-search]').forEach((button) => button.addEventListener('click', () => { setMode('name'); runSearch(button.dataset.search.replace(/^LEGO\s+/i, '')); }));
sortSelect.addEventListener('change', renderResults);
resultsGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-save-index]');
  if (button) saveListing(Number(button.dataset.saveIndex), button);
});

accountButton.addEventListener('click', () => {
  if (session.configured === false) return showNotice('Set up Supabase accounts', 'Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to .env, run supabase/schema.sql, then restart the app.');
  if (session.user) openAccount(); else openAuth();
});

$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$$('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  setFormMessage('#auth-message');
  try {
    const body = { email: $('#auth-email').value, password: $('#auth-password').value };
    if (authMode === 'signup') body.displayName = $('#auth-display-name').value;
    const data = await api(authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { method: 'POST', body });
    if (data.requiresEmailConfirmation) {
      setFormMessage('#auth-message', data.message, true);
      return;
    }
    session.user = data.user;
    session.profile = data.profile || null;
    updateAccountButton();
    authDialog.close();
    await openAccount();
  } catch (error) { setFormMessage('#auth-message', error.message); }
  finally { submit.disabled = false; }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  session.user = null;
  session.profile = null;
  dashboard = null;
  updateAccountButton();
  accountDialog.close();
  if (latest) renderResults();
  showToast('Signed out.');
});

$$('[data-account-tab]').forEach((button) => button.addEventListener('click', () => {
  $$('.account-tab').forEach((tab) => tab.classList.toggle('active', tab === button));
  $$('.account-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.accountPanel === button.dataset.accountTab));
}));

$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('/api/profile', { method: 'PUT', body: { displayName: $('#profile-display-name').value, location: $('#profile-location').value, favoriteTheme: $('#profile-theme').value } });
    dashboard.profile = data.profile;
    session.profile = data.profile;
    renderDashboard();
    updateAccountButton();
    showToast('Profile updated.');
  } catch (error) { setFormMessage('#account-message', error.message); }
});

$('#watchlist-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/watchlists', { method: 'POST', body: { name: $('#watchlist-name').value, searchQuery: $('#watchlist-query').value, setNumber: $('#watchlist-set').value, maxPriceCents: dollarsToCents($('#watchlist-price').value) } });
    event.currentTarget.reset();
    await loadDashboardData(false);
    showToast('Watchlist added.');
  } catch (error) { setFormMessage('#account-message', error.message); }
});

$('#transaction-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/transactions', { method: 'POST', body: { title: $('#transaction-title').value, amountCents: dollarsToCents($('#transaction-amount').value), status: $('#transaction-status').value, occurredAt: $('#transaction-date').value, notes: $('#transaction-notes').value, currency: 'USD' } });
    event.currentTarget.reset();
    $('#transaction-date').value = localDateValue();
    await loadDashboardData(false);
    showToast('Transaction recorded.');
  } catch (error) { setFormMessage('#account-message', error.message); }
});

accountDialog.addEventListener('click', async (event) => {
  const savedButton = event.target.closest('[data-delete-saved]');
  const watchDelete = event.target.closest('[data-delete-watchlist]');
  const watchToggle = event.target.closest('[data-toggle-watchlist]');
  const watchRun = event.target.closest('[data-run-watchlist]');
  const transactionDelete = event.target.closest('[data-delete-transaction]');
  try {
    if (savedButton) await api(`/api/saved-deals/${savedButton.dataset.deleteSaved}`, { method: 'DELETE' });
    else if (watchDelete) await api(`/api/watchlists/${watchDelete.dataset.deleteWatchlist}`, { method: 'DELETE' });
    else if (watchToggle) {
      const item = dashboard.watchlists.find((entry) => entry.id === watchToggle.dataset.toggleWatchlist);
      await api(`/api/watchlists/${item.id}`, { method: 'PATCH', body: { active: !item.active } });
    } else if (watchRun) {
      const item = dashboard.watchlists.find((entry) => entry.id === watchRun.dataset.runWatchlist);
      accountDialog.close();
      setMode(item.set_number ? 'number' : 'name');
      return runSearch(item.set_number || item.search_query);
    } else if (transactionDelete) await api(`/api/transactions/${transactionDelete.dataset.deleteTransaction}`, { method: 'DELETE' });
    else return;
    await loadDashboardData(false);
    if (latest) renderResults();
  } catch (error) { setFormMessage('#account-message', error.message); }
});

accountDialog.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-transaction-status]');
  if (!select) return;
  try {
    await api(`/api/transactions/${select.dataset.transactionStatus}`, { method: 'PATCH', body: { status: select.value } });
    await loadDashboardData(false);
    showToast('Transaction updated.');
  } catch (error) { setFormMessage('#account-message', error.message); }
});

$('#transaction-date').value = localDateValue();
loadSession();
