import nextEnv from "@next/env";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const DEFAULT_FANVUE_API_BASE_URL = "https://api.fanvue.com";
const DEFAULT_FANVUE_OAUTH_BASE_URL = "https://auth.fanvue.com";
const DEFAULT_FANVUE_API_VERSION = "2025-06-26";
const DEFAULT_RECONCILE_INTERVAL_HOURS = 24;
const FAN_INSIGHTS_RECONCILE_COOLDOWN_MS = 30_000;
const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

const OAUTH_TOKEN_STORE_PATH = join(process.cwd(), "data", "oauth-token.json");
const DISCORD_BINDINGS_STORE_PATH = join(process.cwd(), "data", "discord-bindings.json");

class HttpError extends Error {
  constructor(status, bodyText, url) {
    super(`HTTP ${status} for ${url}: ${bodyText}`);
    this.status = status;
    this.bodyText = bodyText;
    this.url = url;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getReconcileIntervalMs() {
  const raw = process.env.DISCORD_BINDINGS_RECONCILE_INTERVAL_HOURS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_RECONCILE_INTERVAL_HOURS;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RECONCILE_INTERVAL_HOURS * 60 * 60 * 1000;
  }

  return Math.max(parsed, 1) * 60 * 60 * 1000;
}

function getConfig() {
  return {
    fanvueApiBaseUrl: process.env.API_BASE_URL ?? DEFAULT_FANVUE_API_BASE_URL,
    fanvueOauthBaseUrl: process.env.OAUTH_ISSUER_BASE_URL ?? DEFAULT_FANVUE_OAUTH_BASE_URL,
    fanvueApiVersion: process.env.FANVUE_API_VERSION ?? DEFAULT_FANVUE_API_VERSION,
    oauthClientId: requiredEnv("OAUTH_CLIENT_ID"),
    oauthClientSecret: requiredEnv("OAUTH_CLIENT_SECRET"),
    discordBotToken: requiredEnv("DISCORD_BOT_TOKEN"),
    discordGuildId: requiredEnv("DISCORD_GUILD_ID"),
    discordRoleId: requiredEnv("DISCORD_ROLE_ID"),
    reconcileIntervalMs: getReconcileIntervalMs(),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();

  if (!response.ok) {
    throw new HttpError(response.status, text, url);
  }

  return tryParseJson(text);
}

async function requestVoid(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();

  if (!response.ok) {
    throw new HttpError(response.status, text, url);
  }
}

function fanvueHeaders(accessToken, apiVersion) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Fanvue-API-Version": apiVersion,
  };
}

async function fanvueGetJson(config, accessToken, path) {
  const url = `${config.fanvueApiBaseUrl}${path}`;
  return requestJson(url, {
    method: "GET",
    headers: fanvueHeaders(accessToken, config.fanvueApiVersion),
  });
}

async function readOAuthTokenRecord() {
  try {
    const raw = await readFile(OAUTH_TOKEN_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);

    if (
      typeof parsed?.accessToken !== "string" ||
      typeof parsed?.expiresAt !== "number" ||
      typeof parsed?.updatedAt !== "string"
    ) {
      return null;
    }

    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      tokenType: parsed.tokenType,
      scope: parsed.scope,
      expiresAt: parsed.expiresAt,
      updatedAt: parsed.updatedAt,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeOAuthTokenRecord(record) {
  const storeDir = dirname(OAUTH_TOKEN_STORE_PATH);
  const tempPath = `${OAUTH_TOKEN_STORE_PATH}.tmp`;

  await mkdir(storeDir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tempPath, OAUTH_TOKEN_STORE_PATH);
}

function createDefaultBindingsStore() {
  return {
    bindingsByFanvueUserUuid: {},
    processedMessageUuids: [],
  };
}

function normalizeBindingsStore(raw) {
  const bindingsByFanvueUserUuid =
    raw && typeof raw.bindingsByFanvueUserUuid === "object" && raw.bindingsByFanvueUserUuid !== null
      ? raw.bindingsByFanvueUserUuid
      : {};

  const processedMessageUuids = Array.isArray(raw?.processedMessageUuids)
    ? raw.processedMessageUuids.filter((value) => typeof value === "string")
    : [];

  return {
    bindingsByFanvueUserUuid,
    processedMessageUuids,
  };
}

async function readDiscordBindingsStore() {
  try {
    const raw = await readFile(DISCORD_BINDINGS_STORE_PATH, "utf8");
    return normalizeBindingsStore(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return createDefaultBindingsStore();
    }
    throw error;
  }
}

async function writeDiscordBindingsStore(store) {
  const storeDir = dirname(DISCORD_BINDINGS_STORE_PATH);
  const tempPath = `${DISCORD_BINDINGS_STORE_PATH}.tmp`;

  await mkdir(storeDir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempPath, DISCORD_BINDINGS_STORE_PATH);
}

async function refreshOAuthToken(config, token) {
  if (!token.refreshToken) {
    throw new Error("Stored OAuth token has expired and no refresh token is available.");
  }

  const refreshBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: config.oauthClientId,
  });

  const tokenUrl = `${config.fanvueOauthBaseUrl}/oauth2/token`;
  const refreshed = await requestJson(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${config.oauthClientId}:${config.oauthClientSecret}`).toString("base64"),
    },
    body: refreshBody.toString(),
  });

  const updated = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? token.refreshToken,
    tokenType: refreshed.token_type,
    scope: refreshed.scope ?? token.scope,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    updatedAt: new Date().toISOString(),
  };

  await writeOAuthTokenRecord(updated);
  return updated;
}

async function getValidAccessToken(config) {
  const storedToken = await readOAuthTokenRecord();

  if (!storedToken) {
    throw new Error("No OAuth token found. Login once via /api/oauth/login before starting the reconciliation worker.");
  }

  const expiresSoon = Date.now() >= storedToken.expiresAt - 60_000;
  if (!expiresSoon) {
    return storedToken;
  }

  return refreshOAuthToken(config, storedToken);
}

async function getFanStatus(config, accessToken, fanUserUuid) {
  try {
    const response = await fanvueGetJson(config, accessToken, `/insights/fans/${fanUserUuid}`);
    return response.status;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return "follower";
    }
    throw error;
  }
}

async function getFanStatusWithCooldown(config, accessToken, fanUserUuid, cooldownState) {
  if (cooldownState.lastFinishedAt > 0) {
    const waitMs = cooldownState.lastFinishedAt + FAN_INSIGHTS_RECONCILE_COOLDOWN_MS - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  try {
    return await getFanStatus(config, accessToken, fanUserUuid);
  } finally {
    cooldownState.lastFinishedAt = Date.now();
  }
}

async function discordDelete(config, path) {
  const url = `${DISCORD_API_BASE_URL}${path}`;
  await requestVoid(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bot ${config.discordBotToken}`,
    },
  });
}

async function removeDiscordRole(config, userId) {
  await discordDelete(config, `/guilds/${config.discordGuildId}/members/${userId}/roles/${config.discordRoleId}`);
}

function isClientError(error) {
  return error instanceof HttpError && error.status >= 400 && error.status < 500;
}

function formatStats(stats) {
  return `bindings=${stats.bindingsScanned}, active=${stats.activeSubscribers}, inactive=${stats.inactiveSubscribers}, rolesRemoved=${stats.rolesRemoved}, bindingsRemoved=${stats.bindingsRemoved}, failures=${stats.failures}`;
}

async function reconcileBindings(config) {
  const stats = {
    bindingsScanned: 0,
    activeSubscribers: 0,
    inactiveSubscribers: 0,
    rolesRemoved: 0,
    bindingsRemoved: 0,
    failures: 0,
  };

  const store = await readDiscordBindingsStore();
  const entries = Object.entries(store.bindingsByFanvueUserUuid);
  stats.bindingsScanned = entries.length;

  if (entries.length === 0) {
    return stats;
  }

  const tokenRecord = await getValidAccessToken(config);
  const accessToken = tokenRecord.accessToken;
  const insightsCooldownState = { lastFinishedAt: 0 };
  let storeChanged = false;

  for (const [fanUserUuid, binding] of entries) {
    try {
      const fanStatus = await getFanStatusWithCooldown(config, accessToken, fanUserUuid, insightsCooldownState);
      if (fanStatus === "subscriber") {
        stats.activeSubscribers += 1;
        continue;
      }

      stats.inactiveSubscribers += 1;

      const discordUserId = typeof binding?.discordUserId === "string" ? binding.discordUserId : null;
      let shouldRemoveBinding = !discordUserId;

      if (discordUserId) {
        try {
          await removeDiscordRole(config, discordUserId);
          stats.rolesRemoved += 1;
          shouldRemoveBinding = true;
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            console.warn(
              `Discord member or role not found while removing subscriber role for fan ${fanUserUuid}; deleting stale binding.`,
            );
            shouldRemoveBinding = true;
          } else if (isClientError(error)) {
            stats.failures += 1;
            console.error(`Failed removing Discord role for fan ${fanUserUuid}`, error);
            continue;
          } else {
            stats.failures += 1;
            console.error(`Unexpected error removing Discord role for fan ${fanUserUuid}`, error);
            continue;
          }
        }
      }

      if (shouldRemoveBinding) {
        delete store.bindingsByFanvueUserUuid[fanUserUuid];
        stats.bindingsRemoved += 1;
        storeChanged = true;
      }
    } catch (error) {
      stats.failures += 1;
      console.error(`Failed reconciling binding for fan ${fanUserUuid}`, error);
    }
  }

  if (storeChanged) {
    await writeDiscordBindingsStore(store);
  }

  return stats;
}

async function runOnce(config) {
  const stats = await reconcileBindings(config);
  console.log(`Binding reconciliation complete: ${formatStats(stats)}`);
}

async function runForever(config) {
  console.log(
    `Starting Discord binding reconciliation worker (interval ${Math.floor(config.reconcileIntervalMs / (60 * 60 * 1000))}h).`,
  );

  while (true) {
    const startedAt = Date.now();

    try {
      const stats = await reconcileBindings(config);
      console.log(`[${new Date().toISOString()}] Binding reconciliation complete: ${formatStats(stats)}`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Binding reconciliation failed`, error);
    }

    const elapsed = Date.now() - startedAt;
    const sleepMs = Math.max(config.reconcileIntervalMs - elapsed, 60_000);
    await sleep(sleepMs);
  }
}

async function main() {
  const config = getConfig();
  const once = process.argv.includes("--once");

  if (once) {
    await runOnce(config);
    return;
  }

  await runForever(config);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
