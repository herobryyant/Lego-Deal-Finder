# BrickScout — LEGO Deal Finder MVP

A responsive LEGO deal app that searches current eBay listings, compares prices, and gives signed-in users profiles, saved deals, watchlists, and transaction history backed by Supabase PostgreSQL.

## Requirements

- Node.js 18 or newer (Node 20 recommended)
- eBay developer Production App ID and Cert ID for live results
- A free Supabase project

The app uses eBay's Browse API with an application access token. Create an eBay developer account and application at [developer.ebay.com](https://developer.ebay.com/), then use the production credentials for the application.

## Run locally

1. Copy `.env.example` to `.env`.
2. In eBay **Application Keys**, choose either the Production or Sandbox keyset.
3. Copy **App ID (Client ID)** to `EBAY_CLIENT_ID` and **Cert ID (Client Secret)** to `EBAY_CLIENT_SECRET`. Both must come from the same keyset. Do not copy the Dev ID or an OAuth token.
4. Set `EBAY_ENVIRONMENT=production` or `EBAY_ENVIRONMENT=sandbox` to match that keyset.
5. Test the credentials:

   ```bash
   npm run check:ebay
   ```

6. Start the app:

   ```bash
   npm start
   ```

7. Open [http://localhost:3000](http://localhost:3000).

There are no npm package dependencies to install. Keep `.env` private. The server keeps authentication sessions in HTTP-only cookies and never exposes the eBay secret. The Supabase publishable key is safe to identify the application; database access is still restricted by authenticated user tokens and Row Level Security.

## Configure Supabase

1. Create a project at [supabase.com](https://supabase.com/).
2. Open **SQL Editor**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and run it once.
3. Open **Project Settings → API** and copy the Project URL and publishable key into `.env`:

   ```env
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_PUBLISHABLE_KEY=your-publishable-key
   COOKIE_SECURE=false
   ```

4. In **Authentication → URL Configuration**, set the Site URL to `http://localhost:3000` for local development.
5. Restart the Node server or recreate the Docker container.

The SQL migration creates `profiles`, `saved_deals`, `watchlists`, and `transactions`, a profile trigger for new accounts, indexes, constraints, and Row Level Security policies. Do not put a Supabase secret or service-role key in this project; it is not required.

## Fix `client authentication failed`

This response comes from eBay's token endpoint before a listing search runs. Check these items:

1. `EBAY_CLIENT_ID` contains the **App ID**, not the Dev ID.
2. `EBAY_CLIENT_SECRET` contains the **Cert ID**, not a generated token.
3. The App ID and Cert ID are copied from the same keyset.
4. Sandbox keys use `EBAY_ENVIRONMENT=sandbox`; Production keys use `EBAY_ENVIRONMENT=production`.
5. In the eBay developer portal, confirm the Production keyset is enabled. New Production keysets remain disabled until the Marketplace Account Deletion/Closure requirement is completed.
6. Restart `npm start` or recreate the Docker container after changing `.env`.

Run `npm run check:ebay` again. A successful result confirms authentication without printing either credential.

### Enabling a new Production keyset

eBay requires production applications to subscribe to Marketplace Account Deletion/Closure notifications or qualify for an exemption. This version persists selected eBay listing details in `saved_deals`, so **do not claim that the application persists no eBay data**. Use Sandbox keys while developing, then complete eBay's notification subscription and production requirements before using Production credentials.

The server includes an eBay-compatible callback at `GET/POST /api/ebay/account-deletion`. The GET handler answers eBay's endpoint challenge, and the POST handler verifies the `X-EBAY-SIGNATURE` header with eBay's public key before processing and acknowledging a notification.

After deploying to a public HTTPS domain:

1. Generate a verification token containing 32–80 letters, numbers, underscores, or hyphens:

   ```bash
   openssl rand -hex 32
   ```

2. Set these production environment variables. The endpoint value must exactly match the URL entered in eBay, including its path and any trailing slash:

   ```env
   EBAY_DELETION_ENDPOINT=https://your-app.onrender.com/api/ebay/account-deletion
   EBAY_DELETION_VERIFICATION_TOKEN=paste-the-generated-token
   ```

3. Deploy or restart the server. Confirm `/api/health` reports `"deletionNotificationsConfigured": true`.
4. In eBay's Alerts and Notifications page, save a monitored failure email, paste the endpoint URL and the same verification token, then click **Save**.
5. After validation succeeds, click **Send Test Notification**.

The current database schema does not persist eBay usernames, immutable eBay user IDs, or EIAS tokens, so a verified deletion event has no account-linked rows to remove. If any of those identifiers are stored later, extend `processDeletionNotification` in `server.js` to delete or irreversibly anonymize the matching records.

## Deploy on Render

This repository includes `render.yaml` for a Docker-based web service.

1. Push the project to a private or public GitHub repository. Do not commit `.env`.
2. In Render, choose **New → Blueprint**, connect the repository, and select its `render.yaml`.
3. Enter each secret value requested by Render. Generate the deletion verification token locally and use the same value in Render and eBay.
4. Create the Blueprint and wait for the health check to pass.
5. Copy the assigned URL, such as `https://lego-deal-finder.onrender.com`.
6. Render supplies its hostname to the app automatically, so use the assigned URL plus `/api/ebay/account-deletion` as the endpoint in eBay. You do not need to set `EBAY_DELETION_ENDPOINT` on Render.
7. Update Supabase **Authentication → URL Configuration → Site URL** to the Render URL.
8. Open `https://YOUR-DOMAIN/api/health` and verify that the eBay, database, and deletion-notification configuration fields are `true` before completing the eBay form.

Render's free web service sleeps after inactivity, so it can take about a minute to wake. Open the app immediately before saving the endpoint in eBay. For a production compliance endpoint that must respond consistently, use an always-on paid instance.

## Run with Docker

Create `.env` as above, then run:

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). To stop it, press `Ctrl+C` or run `docker compose down` in another terminal.

## MVP behavior

- Search by LEGO set name or set number
- Load up to 50 active eBay Browse API matches
- Include shipping in the displayed total when eBay provides shipping cost
- Sort by lowest total or biggest discount from the current listing median
- Open the original listing on eBay
- Responsive layout and quick searches for sample set numbers
- Email/password account creation and sign-in through Supabase Auth
- User profiles with display name, location, and favorite LEGO theme
- One-click saved deals from search results
- Watchlists with search terms, set number, maximum price, and active/paused status
- Transaction history for planned, purchased, sold, and cancelled items
- HTTP-only authentication cookies and automatic session refresh
- PostgreSQL Row Level Security for all user-owned records

## Important limitations

- The reference is the median of current active search results, not sold/completed prices or official LEGO MSRP. Search results may include bundles or mismatched listings; check the listing carefully.
- eBay Buy API access and usage depend on your developer account and eBay's current eligibility/terms. Some accounts may need production access enabled.
- Shipping may be missing or location-dependent in API results, so the final checkout total can differ.
- Watchlists are saved, but automatic background price checks and notifications are not implemented yet.
- Transaction history is a personal record. The app does not process payments and must not store card numbers or security codes.

## API

- `GET /api/health` — reports server status and whether eBay credentials are configured
- `GET/POST /api/ebay/account-deletion` — verify the callback and receive signed eBay account deletion notifications
- `GET /api/search?q=millennium%20falcon` — search by name
- `GET /api/search?set=75375` — search by set number
- `GET /api/auth/session` — get the current signed-in user
- `POST /api/auth/signup`, `/api/auth/login`, `/api/auth/logout` — authentication
- `GET /api/dashboard` — load the signed-in user's profile and collections
- `PUT /api/profile` — update the current profile
- `POST /api/saved-deals`, `DELETE /api/saved-deals/:id` — save or remove deals
- `POST /api/watchlists`, `PATCH/DELETE /api/watchlists/:id` — manage watchlists
- `POST /api/transactions`, `PATCH/DELETE /api/transactions/:id` — manage transaction history
