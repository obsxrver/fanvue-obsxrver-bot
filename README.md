# Fanvue Discord Role Bot (Next.js + worker)

## Requirements

- pnpm
- Node 18+
- An existing Fanvue App from [Fanvue Developer Area](https://fanvue.com/developers/apps) (client id/secret)

## Setup

1. Create `.env.local` using `.env.example`

2. Install deps and run:

```bash
pnpm install
pnpm dev
```

3. Set up HTTPS for local development:

#### Option A: Using [portless](https://github.com/vercel-labs/portless) (Recommended)

Portless gives you stable, named `.localhost` URLs with automatic HTTPS/HTTP2 — no manual cert generation or hosts file editing.

```bash
npm install -g portless
```

One-time setup (generates and trusts certs automatically):

```bash
portless proxy start --https
```

Update your `package.json` dev script:

```json
{
  "scripts": {
    "dev": "portless run next dev"
  }
}
```

Then run:

```bash
pnpm dev
# -> https://fanvue-app-starter.localhost
```

Now set your redirect URI in the Fanvue UI to match:

```
https://fanvue-app-starter.localhost/api/oauth/callback
```

#### Option B: Manual mkcert + local-ssl-proxy

Insert the actual name of your app instead of `[your-app-name-here]`

Install mkcert and generate certificates

```
brew install mkcert
mkcert -install
mkcert [your-app-name-here].dev
```

Change your hosts file

```
echo "127.0.0.1 [your-app-name-here].dev" | sudo tee -a /etc/hosts
```

Then run the local SSL proxy

```
npx local-ssl-proxy --source 3001 --target 3000 --cert ./[your-app-name-here].dev.pem --key ./[your-app-name-here].dev-key.pem
```

Now setup your redirect URI in the Fanvue UI to match:

```
https://[your-app-name-here].dev:3001/api/oauth/callback
```

## Environment variables (.env)

### Get your Fanvue OAuth credentials

1. Visit [Fanvue Developer Area](https://fanvue.com/developers)
2. Create a new App to obtain your Client ID and Client Secret
3. Configure a Redirect URI
   - Development: `http://localhost:3000/api/oauth/callback`
   - Production: `https://YOUR_DOMAIN/api/oauth/callback`
4. Configure scopes
   - For Discord role sync from DMs, you need: `read:self read:chat write:chat read:fan read:insights`
   - The scopes you set in your `.env` must exactly match what you select in the Fanvue developer UI for your app
   - Note: The app automatically includes required system scopes (`openid`, `offline_access`, `offline`) in addition to what you set in `OAUTH_SCOPES`

Required variables

- `OAUTH_CLIENT_ID`: From your Fanvue app
- `OAUTH_CLIENT_SECRET`: From your Fanvue app
- `OAUTH_SCOPES`: App scopes selected in the Fanvue UI (e.g. `read:self`)
- `OAUTH_REDIRECT_URI`: Full URL to `/api/oauth/callback` for your environment
- `BASE_URL`: Public base URL for this app (used by OAuth callback redirects)
- `SESSION_SECRET`: A random string of at least 16 characters
- `SESSION_COOKIE_NAME` (default: `fanvue_oauth`)
- `DISCORD_BOT_TOKEN`: Your Discord bot token
- `DISCORD_GUILD_ID`: Guild/server ID where the role will be applied
- `DISCORD_ROLE_ID`: Role ID to assign when a subscriber DMs `/discord <username>`, or when `obsxrver` sends `/bind <username>` in that fan's DM
- `DISCORD_BINDINGS_RECONCILE_INTERVAL_HOURS` (optional, default: `24`): How often the reconciliation worker re-checks existing bindings and removes stale subscriber roles

These are not something you should change

- `OAUTH_ISSUER_BASE_URL` (default: `https://auth.fanvue.com`)
- `API_BASE_URL` (default: `https://api.fanvue.com`)

Example `.env.local` (development)

```bash
OAUTH_CLIENT_ID=YOUR_CLIENT_ID
OAUTH_CLIENT_SECRET=YOUR_CLIENT_SECRET
OAUTH_SCOPES=read:self read:chat write:chat read:fan read:insights
OAUTH_REDIRECT_URI=http://localhost:3000/api/oauth/callback
BASE_URL=http://localhost:3000
SESSION_SECRET=use-a-random-16-char-secret
OAUTH_ISSUER_BASE_URL=https://auth.fanvue.com
API_BASE_URL=https://api.fanvue.com
SESSION_COOKIE_NAME=fanvue_oauth
DISCORD_BOT_TOKEN=YOUR_DISCORD_BOT_TOKEN
DISCORD_GUILD_ID=YOUR_DISCORD_GUILD_ID
DISCORD_ROLE_ID=YOUR_DISCORD_ROLE_ID
# Optional: defaults to 20
DISCORD_SYNC_POLL_INTERVAL_SECONDS=20
# Optional: defaults to 24
DISCORD_BINDINGS_RECONCILE_INTERVAL_HOURS=24
```

## Discord DM -> Role sync flow

Once configured, the worker does this:

1. Poll recent Fanvue chats.
2. Parse either `/discord <discord username or user id>` from the fan, or `/bind <discord username or user id>` from `obsxrver` in that fan's DM thread.
3. For `/discord`, verify the sender is an active paid subscriber (`status=subscriber` via Fanvue insights API).
4. Resolve that Discord member in your configured guild, assign `DISCORD_ROLE_ID`, and persist the Fanvue-to-Discord binding for the DM recipient.
5. Persist state into `data/discord-bindings.json` to avoid duplicate grants and keep the account mapping.

The OAuth callback also stores a refreshable token in `data/oauth-token.json`, which the worker uses for API calls.

## Daily binding reconciliation

The reconciliation worker reads `data/discord-bindings.json`, checks each bound Fanvue account once per interval, and if the account is no longer an active subscriber it:

1. Removes `DISCORD_ROLE_ID` from the bound Discord member.
2. Deletes that Fanvue-to-Discord binding from `data/discord-bindings.json`.

If the Discord member or role is already gone, the worker still removes the stale binding.

### Start the worker

After you login once through the web app (`/api/oauth/login`), run:

```bash
pnpm sync:discord-roles
```

One-shot test pass:

```bash
pnpm sync:discord-roles:once
```

Start the reconciliation worker:

```bash
pnpm reconcile:discord-bindings
```

One-shot reconciliation pass:

```bash
pnpm reconcile:discord-bindings:once
```

## Production deployment

- Set the same environment variables in your hosting provider for production
- Ensure the Fanvue app has the production Redirect URI configured: `https://YOUR_DOMAIN/api/oauth/callback`
- Ensure `BASE_URL` and `OAUTH_REDIRECT_URI` match your public domain
- Ensure `OAUTH_SCOPES` exactly matches your selected scopes (e.g. `read:self read:chat write:chat read:fan read:insights`)
- Build and run

```bash
pnpm install
pnpm build
pnpm start
```

For your EC2 host, your public base URL would be:

`http://ec2-54-82-239-248.compute-1.amazonaws.com`

So in production, set:

- `BASE_URL=http://ec2-54-82-239-248.compute-1.amazonaws.com`
- `OAUTH_REDIRECT_URI=http://ec2-54-82-239-248.compute-1.amazonaws.com/api/oauth/callback`

### Recommended Services

To deploy, we recommend using [Vercel](https://vercel.com/)

If you need a database, [Supabase](https://supabase.com/) should have you covered

Usage

- Visit `/` and click “Login with Fanvue” once (this seeds `data/oauth-token.json`)
- Keep `pnpm sync:discord-roles` running on your server
- Keep `pnpm reconcile:discord-bindings` running on your server
- When a paying subscriber DMs `/discord <their_discord_username>`, the worker assigns the configured Discord role
- When `obsxrver` sends `/bind <their_discord_username>` inside a fan DM, the worker binds that DM recipient's Fanvue account to the Discord user and applies the same role
- Once per day by default, the reconciliation worker removes `DISCORD_ROLE_ID` and deletes bindings for accounts that are no longer active subscribers
- Mapping state is written to `data/discord-bindings.json`
- Click “Logout” in the web app only if you want to clear browser session state (worker token remains in `data/oauth-token.json`)

Docs

- Fanvue API: [https://api.fanvue.com/docs](https://api.fanvue.com/docs)
