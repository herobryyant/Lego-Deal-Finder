"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/
    );

    if (!match || match[1] in process.env) continue;

    process.env[match[1]] = match[2].replace(
      /^(['"])(.*)\1$/,
      "$2"
    );
  }
}

function clean(value) {
  return String(value || "")
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim();
}

function requiredEnv(name) {
  const value = clean(process.env[name]);

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}`
    );
  }

  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function buildSearchQuery(watchlist) {
  const setNumber = clean(watchlist.set_number);
  const searchQuery = clean(watchlist.search_query);

  return setNumber
    ? `LEGO ${setNumber}`
    : `LEGO ${searchQuery}`;
}

function toCandidate(item) {
  const price = Number(item?.price?.value);

  const shipping = Number(
    item?.shippingOptions?.[0]?.shippingCost?.value
  );

  const currency = clean(
    item?.price?.currency || "USD"
  ).toUpperCase();

  // Skip listings where shipping is unknown.
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(shipping)
  ) {
    return null;
  }

  if (
    price < 0 ||
    shipping < 0 ||
    currency !== "USD"
  ) {
    return null;
  }

  const totalPriceCents = Math.round(
    (price + shipping) * 100
  );

  if (
    !Number.isSafeInteger(totalPriceCents) ||
    totalPriceCents < 0
  ) {
    return null;
  }

  const id = clean(item.itemId);
  const title = clean(item.title);
  const listingUrl = clean(item.itemWebUrl);

  if (
    !id ||
    !title ||
    !/^https:\/\//i.test(listingUrl)
  ) {
    return null;
  }

  return {
    id,
    title,
    listingUrl,
    imageUrl: clean(
      item.image?.imageUrl ||
      item.thumbnailImages?.[0]?.imageUrl
    ),
    priceCents: Math.round(price * 100),
    shippingCents: Math.round(shipping * 100),
    totalPriceCents,
    currency,
  };
}

function chooseCandidate(items, maximumPriceCents) {
  const maximum = Number(maximumPriceCents);

  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 0
  ) {
    return null;
  }

  return (
    (items || [])
      .map(toCandidate)
      .filter(
        (item) =>
          item &&
          item.totalPriceCents <= maximum
      )
      .sort(
        (a, b) =>
          a.totalPriceCents - b.totalPriceCents
      )[0] || null
  );
}

function createSupabaseAdmin({
  url,
  secretKey,
}) {
  const baseUrl = clean(url).replace(/\/$/, "");
  const key = clean(secretKey);

  async function request(resource, options = {}) {
    const method = options.method || "GET";

    const headers = {
      apikey: key,
      accept: "application/json",
      "user-agent":
        "lego-deal-finder-price-alert-worker/1.0",
      ...options.headers,
    };

    if (options.prefer) {
      headers.prefer = options.prefer;
    }

    if (options.body !== undefined) {
      headers["content-type"] =
        "application/json";
    }

    const response = await fetch(
      `${baseUrl}/rest/v1/${resource}`,
      {
        method,
        headers,
        body:
          options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
      }
    );

    const raw = await response.text();
    let data = null;

    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }

    if (!response.ok) {
      const message =
        data?.message ||
        data?.hint ||
        data?.error ||
        raw ||
        "Unknown error";

      throw new Error(
        `Supabase request failed (${response.status}): ${message}`
      );
    }

    return data;
  }

  return {
    request,
  };
}

function createEbayClient({
  clientId,
  clientSecret,
  environment,
  marketplaceId,
}) {
  const sandbox =
    clean(environment).toLowerCase() ===
    "sandbox";

  const apiOrigin = sandbox
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";

  let tokenCache = {
    value: null,
    expiresAt: 0,
  };

  async function getToken() {
    if (
      tokenCache.value &&
      Date.now() < tokenCache.expiresAt
    ) {
      return tokenCache.value;
    }

    const credentials = Buffer.from(
      `${clientId}:${clientSecret}`
    ).toString("base64");

    const response = await fetch(
      `${apiOrigin}/identity/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${credentials}`,
          "content-type":
            "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope:
            "https://api.ebay.com/oauth/api_scope",
        }),
      }
    );

    const data = await response
      .json()
      .catch(() => ({}));

    if (!response.ok || !data.access_token) {
      throw new Error(
        data.error_description ||
        data.error ||
        `eBay authentication failed (${response.status}).`
      );
    }

    tokenCache = {
      value: data.access_token,
      expiresAt:
        Date.now() +
        Math.max(
          60,
          Number(data.expires_in || 7200) - 120
        ) *
          1000,
    };

    return tokenCache.value;
  }

  async function search(watchlist) {
    const query = buildSearchQuery(watchlist);
    const token = await getToken();

    const params = new URLSearchParams({
      q: query,
      limit: "50",
      sort: "price",
    });

    const response = await fetch(
      `${apiOrigin}/buy/browse/v1/item_summary/search?${params.toString()}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID":
            marketplaceId,
          "X-EBAY-C-ENDUSERCTX":
            "contextualLocation=country=US",
        },
      }
    );

    const data = await response
      .json()
      .catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.errors?.[0]?.message ||
        data.error_description ||
        `eBay search failed (${response.status}).`
      );
    }

    return data.itemSummaries || [];
  }

  return {
    search,
  };
}

function createEmailClient({
  apiKey,
  fromEmail,
  appUrl,
}) {
  async function send({
    to,
    watchlist,
    listing,
  }) {
    const total = (
      listing.totalPriceCents / 100
    ).toFixed(2);

    const target = (
      Number(watchlist.max_price_cents) / 100
    ).toFixed(2);

    const safeTitle = escapeHtml(
      listing.title
    );

    const safeName = escapeHtml(
      watchlist.name
    );

    const safeUrl = escapeHtml(
      listing.listingUrl
    );

    const safeAppUrl = escapeHtml(appUrl);

    const response = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [to],

          subject:
            `LEGO price alert: ` +
            `${watchlist.name} is $${total}`,

          text: [
            `${listing.title} is now $${total} including shipping.`,
            `Your target price for ${watchlist.name} is $${target}.`,
            `View listing: ${listing.listingUrl}`,
            `Manage alerts: ${appUrl}`,
          ].join("\n\n"),

          html: `
            <div style="
              font-family: Arial, sans-serif;
              max-width: 620px;
              margin: auto;
              line-height: 1.5;
              color: #172033;
            ">
              <h1 style="font-size: 24px;">
                LEGO price alert
              </h1>

              <p>
                <strong>${safeTitle}</strong>
                is now
                <strong>$${total}</strong>
                including shipping.
              </p>

              <p>
                Your target price for
                <strong>${safeName}</strong>
                is $${target}.
              </p>

              <p>
                <a
                  href="${safeUrl}"
                  style="
                    display: inline-block;
                    padding: 12px 18px;
                    background: #2563eb;
                    color: white;
                    text-decoration: none;
                    border-radius: 6px;
                  "
                >
                  View eBay listing
                </a>
              </p>

              <p style="
                font-size: 13px;
                color: #64748b;
              ">
                Listings can change or sell at
                any time.
                <a href="${safeAppUrl}">
                  Manage your alerts
                </a>.
              </p>
            </div>
          `,
        }),
      }
    );

    const data = await response
      .json()
      .catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.message ||
        data.name ||
        `Resend request failed (${response.status}).`
      );
    }

    return data;
  }

  return {
    send,
  };
}

function watchlistQuery() {
  const params = new URLSearchParams({
    select:
      "id,user_id,name,search_query," +
      "set_number,max_price_cents,active," +
      "email_alerts,last_checked_at",

    active: "eq.true",
    email_alerts: "eq.true",
    max_price_cents: "not.is.null",
    order: "updated_at.asc",
  });

  return `watchlists?${params.toString()}`;
}

function profileQuery() {
  const params = new URLSearchParams({
    select: "user_id,alert_email",
    alert_email: "not.is.null",
  });

  return `profiles?${params.toString()}`;
}

function priorAlertQuery(
  watchlistId,
  listing
) {
  const params = new URLSearchParams({
    select: "id",
    watchlist_id: `eq.${watchlistId}`,
    ebay_item_id: `eq.${listing.id}`,
    total_price_cents:
      `eq.${listing.totalPriceCents}`,
    limit: "1",
  });

  return `price_alerts?${params.toString()}`;
}

function watchlistUpdateQuery(watchlistId) {
  const params = new URLSearchParams({
    id: `eq.${watchlistId}`,
  });

  return `watchlists?${params.toString()}`;
}

async function run() {
  loadEnv();

  const config = {
    supabaseUrl:
      requiredEnv("SUPABASE_URL"),

    supabaseSecretKey:
      requiredEnv("SUPABASE_SECRET_KEY"),

    ebayClientId:
      requiredEnv("EBAY_CLIENT_ID"),

    ebayClientSecret:
      requiredEnv("EBAY_CLIENT_SECRET"),

    ebayEnvironment:
      clean(
        process.env.EBAY_ENVIRONMENT ||
        "production"
      ),

    ebayMarketplaceId:
      clean(
        process.env.EBAY_MARKETPLACE_ID ||
        "EBAY_US"
      ),

    resendApiKey:
      requiredEnv("RESEND_API_KEY"),

    alertFromEmail:
      requiredEnv("ALERT_FROM_EMAIL"),

    appUrl:
      clean(
        process.env.APP_URL ||
        "https://lego-deal-finder.onrender.com"
      ),
  };

  if (
    !/^https:\/\//i.test(
      config.supabaseUrl
    )
  ) {
    throw new Error(
      "SUPABASE_URL must use HTTPS."
    );
  }

  if (
    !/^https:\/\//i.test(config.appUrl)
  ) {
    throw new Error(
      "APP_URL must use HTTPS."
    );
  }

  if (
    !/^(production|sandbox)$/i.test(
      config.ebayEnvironment
    )
  ) {
    throw new Error(
      "EBAY_ENVIRONMENT must be production or sandbox."
    );
  }

  const supabase = createSupabaseAdmin({
    url: config.supabaseUrl,
    secretKey: config.supabaseSecretKey,
  });

  const ebay = createEbayClient({
    clientId: config.ebayClientId,
    clientSecret: config.ebayClientSecret,
    environment: config.ebayEnvironment,
    marketplaceId:
      config.ebayMarketplaceId,
  });

  const email = createEmailClient({
    apiKey: config.resendApiKey,
    fromEmail: config.alertFromEmail,
    appUrl: config.appUrl,
  });

  const [watchlists, profiles] =
    await Promise.all([
      supabase.request(watchlistQuery()),
      supabase.request(profileQuery()),
    ]);

  const emailByUserId = new Map(
    (profiles || [])
      .filter((profile) =>
        /^\S+@\S+\.\S+$/.test(
          clean(profile.alert_email)
        )
      )
      .map((profile) => [
        profile.user_id,
        clean(
          profile.alert_email
        ).toLowerCase(),
      ])
  );

  const stats = {
    checked: 0,
    sent: 0,
    duplicates: 0,
    noMatch: 0,
    missingEmail: 0,
    failed: 0,
  };

  for (const watchlist of watchlists || []) {
    const recipient = emailByUserId.get(
      watchlist.user_id
    );

    if (!recipient) {
      stats.missingEmail += 1;
      continue;
    }

    try {
      const items = await ebay.search(
        watchlist
      );

      const listing = chooseCandidate(
        items,
        Number(watchlist.max_price_cents)
      );

      stats.checked += 1;

      await supabase.request(
        watchlistUpdateQuery(watchlist.id),
        {
          method: "PATCH",
          body: {
            last_checked_at:
              new Date().toISOString(),
          },
          prefer: "return=minimal",
        }
      );

      if (!listing) {
        stats.noMatch += 1;
        continue;
      }

      const existing =
        await supabase.request(
          priorAlertQuery(
            watchlist.id,
            listing
          )
        );

      if (existing?.length) {
        stats.duplicates += 1;
        continue;
      }

      await email.send({
        to: recipient,
        watchlist,
        listing,
      });

      await supabase.request(
        "price_alerts",
        {
          method: "POST",

          body: {
            watchlist_id: watchlist.id,
            user_id: watchlist.user_id,
            ebay_item_id: listing.id,
            title: listing.title,
            listing_url:
              listing.listingUrl,
            total_price_cents:
              listing.totalPriceCents,
          },

          prefer: "return=minimal",
        }
      );

      stats.sent += 1;

      console.log(
        `Sent one alert for watchlist ${watchlist.id}.`
      );
    } catch (error) {
      stats.failed += 1;

      console.error(
        `Watchlist ${watchlist.id} failed: ${error.message}`
      );
    }

    // Keep requests modest for the APIs.
    await sleep(300);
  }

  console.log(
    `Price alert check complete: ` +
    `${stats.checked} checked, ` +
    `${stats.sent} sent, ` +
    `${stats.duplicates} duplicates, ` +
    `${stats.noMatch} without a match, ` +
    `${stats.missingEmail} without an email, ` +
    `${stats.failed} failed.`
  );

  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(
      `Price alert worker failed: ${error.message}`
    );

    process.exitCode = 1;
  });
}

module.exports = {
  buildSearchQuery,
  chooseCandidate,
  toCandidate,
};
