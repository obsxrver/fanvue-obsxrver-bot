import nextEnv from "@next/env";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const DEFAULT_FANVUE_API_BASE_URL = "https://api.fanvue.com";
const DEFAULT_FANVUE_OAUTH_BASE_URL = "https://auth.fanvue.com";
const DEFAULT_FANVUE_API_VERSION = "2025-06-26";
const DEFAULT_POLL_INTERVAL_SECONDS = 20;
const MAX_CHAT_PAGES = 10;
const MAX_CHAT_MESSAGE_PAGES = 5;
const MAX_PROCESSED_MESSAGES = 5000;
const SUPPORTED_COMMANDS = new Set(["bind", "discord"]);
const BIND_COMMAND_ALLOWED_HANDLE = "obsxrver";
const BIND_COMMAND_ALLOWED_USER_UUID = "b684ec34-2373-40d9-bd8d-5e5ce82ab727";
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

function getPollIntervalMs() {
  const raw = process.env.DISCORD_SYNC_POLL_INTERVAL_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_POLL_INTERVAL_SECONDS;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_POLL_INTERVAL_SECONDS * 1000;
  }

  return Math.max(parsed, 5) * 1000;
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
    pollIntervalMs: getPollIntervalMs(),
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

async function fanvuePostJson(config, accessToken, path, payload) {
  const url = `${config.fanvueApiBaseUrl}${path}`;
  return requestJson(url, {
    method: "POST",
    headers: {
      ...fanvueHeaders(accessToken, config.fanvueApiVersion),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
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

function markMessageProcessed(store, messageUuid) {
  if (store.processedMessageUuids.includes(messageUuid)) {
    return false;
  }

  store.processedMessageUuids.push(messageUuid);

  if (store.processedMessageUuids.length > MAX_PROCESSED_MESSAGES) {
    const removeCount = store.processedMessageUuids.length - MAX_PROCESSED_MESSAGES;
    store.processedMessageUuids.splice(0, removeCount);
  }

  return true;
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
    throw new Error("No OAuth token found. Login once via /api/oauth/login before starting the sync worker.");
  }

  const expiresSoon = Date.now() >= storedToken.expiresAt - 60_000;
  if (!expiresSoon) {
    return storedToken;
  }

  return refreshOAuthToken(config, storedToken);
}

async function listRecentChats(config, accessToken) {
  const chats = [];

  for (let page = 1; page <= MAX_CHAT_PAGES; page += 1) {
    const response = await fanvueGetJson(config, accessToken, `/chats?page=${page}&size=50`);
    chats.push(...response.data);

    if (!response.pagination?.hasMore) {
      break;
    }
  }

  return chats;
}

async function listChatMessages(config, accessToken, userUuid) {
  const messages = [];

  for (let page = 1; page <= MAX_CHAT_MESSAGE_PAGES; page += 1) {
    const response = await fanvueGetJson(
      config,
      accessToken,
      `/chats/${userUuid}/messages?page=${page}&size=50&markAsRead=false`,
    );
    messages.push(...response.data);

    if (!response.pagination?.hasMore) {
      break;
    }
  }

  return messages;
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

async function sendFanvueReply(config, accessToken, fanUserUuid, text) {
  await fanvuePostJson(config, accessToken, `/chats/${fanUserUuid}/message`, { text });
}

function normalizeDiscordInput(input) {
  return input.trim().replace(/^@/, "");
}

function extractDiscordUserId(input) {
  const mentionMatch = input.match(/^<@!?(\d{17,20})>$/);
  if (mentionMatch?.[1]) {
    return mentionMatch[1];
  }

  if (/^\d{17,20}$/.test(input)) {
    return input;
  }

  return null;
}

function getDiscordCandidateNames(member) {
  const names = [member.user.username, member.user.global_name, member.nick];
  return names.filter((value) => typeof value === "string" && value.length > 0);
}

function formatDiscordMember(member) {
  const displayName = member.user.global_name ?? member.nick;
  if (displayName) {
    return `${member.user.username} (${displayName})`;
  }
  return member.user.username;
}

async function discordGetJson(config, path) {
  const url = `${DISCORD_API_BASE_URL}${path}`;
  return requestJson(url, {
    method: "GET",
    headers: {
      Authorization: `Bot ${config.discordBotToken}`,
    },
  });
}

async function discordPut(config, path) {
  const url = `${DISCORD_API_BASE_URL}${path}`;
  await requestVoid(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${config.discordBotToken}`,
    },
  });
}

async function getDiscordMemberById(config, userId) {
  try {
    return await discordGetJson(config, `/guilds/${config.discordGuildId}/members/${userId}`);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function resolveDiscordMember(config, discordInput) {
  const normalizedInput = normalizeDiscordInput(discordInput);
  const extractedUserId = extractDiscordUserId(normalizedInput);

  if (extractedUserId) {
    const member = await getDiscordMemberById(config, extractedUserId);
    if (!member) {
      return { kind: "not_found", normalizedInput };
    }
    return { kind: "found", normalizedInput, member };
  }

  const searchQuery = encodeURIComponent(normalizedInput);
  const members = await discordGetJson(
    config,
    `/guilds/${config.discordGuildId}/members/search?query=${searchQuery}&limit=25`,
  );

  const normalizedLower = normalizedInput.toLowerCase();
  const exactMatches = members.filter((member) =>
    getDiscordCandidateNames(member).some((name) => name.toLowerCase() === normalizedLower),
  );

  if (exactMatches.length === 1) {
    return {
      kind: "found",
      normalizedInput,
      member: exactMatches[0],
    };
  }

  if (exactMatches.length > 1) {
    return {
      kind: "ambiguous",
      normalizedInput,
      matches: exactMatches.map(formatDiscordMember).slice(0, 5),
    };
  }

  return { kind: "not_found", normalizedInput };
}

async function assignDiscordRole(config, userId) {
  await discordPut(config, `/guilds/${config.discordGuildId}/members/${userId}/roles/${config.discordRoleId}`);
}

function getDiscordCommandInput(messageText) {
  if (!messageText) {
    return null;
  }

  const match = messageText.trim().match(/^\/([a-z]+)\s+(.+)$/i);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const commandName = match[1].toLowerCase();
  if (!SUPPORTED_COMMANDS.has(commandName)) {
    return null;
  }

  const input = match[2].trim();
  if (input.length === 0) {
    return null;
  }

  return {
    commandName,
    input,
  };
}

function summarizeDiscordMatchAmbiguity(matches) {
  if (matches.length === 0) {
    return "I found multiple matching Discord users. Please DM `/discord your_exact_username`.";
  }

  return `I found multiple Discord users for that name (${matches.join(", ")}). Please DM \`/discord\` with your exact username or user ID.`;
}

function isClientError(error) {
  return error instanceof HttpError && error.status >= 400 && error.status < 500;
}

async function bindDiscordAccount({
  config,
  fanUserUuid,
  fanHandle,
  discordInput,
  sourceMessageUuid,
  sourceCommandName,
  requestedByFanvueHandle,
}) {
  const memberResolution = await resolveDiscordMember(config, discordInput);

  if (memberResolution.kind === "not_found") {
    return memberResolution;
  }

  if (memberResolution.kind === "ambiguous") {
    return memberResolution;
  }

  try {
    await assignDiscordRole(config, memberResolution.member.user.id);
  } catch (error) {
    if (isClientError(error)) {
      return { kind: "role_assignment_failed" };
    }
    throw error;
  }

  return {
    kind: "bound",
    binding: {
      fanvueUserUuid: fanUserUuid,
      fanvueHandle: fanHandle,
      discordInput,
      discordUserId: memberResolution.member.user.id,
      discordUsername: memberResolution.member.user.username,
      discordDisplayName: memberResolution.member.user.global_name ?? memberResolution.member.nick,
      sourceMessageUuid,
      sourceCommandName,
      requestedByFanvueHandle: requestedByFanvueHandle ?? null,
      assignedRoleId: config.discordRoleId,
      updatedAt: new Date().toISOString(),
    },
    member: memberResolution.member,
  };
}

async function processDiscordCommand({ config, accessToken, fanUserUuid, fanHandle, discordInput, sourceMessageUuid }) {
  const fanStatus = await getFanStatus(config, accessToken, fanUserUuid);

  if (fanStatus !== "subscriber") {
    return {
      replyText: "This command is only available to active paid subscribers.",
    };
  }

  const outcome = await bindDiscordAccount({
    config,
    fanUserUuid,
    fanHandle,
    discordInput,
    sourceMessageUuid,
    sourceCommandName: "discord",
    requestedByFanvueHandle: fanHandle,
  });

  if (outcome.kind === "not_found") {
    return {
      replyText: `I couldn't find \`${outcome.normalizedInput}\` in the Discord server. Make sure to join the server first. [https://discord.gg/8wMr2mmaRF](https://discord.gg/8wMr2mmaRF). Please send your exact username or user ID.`,
    };
  }

  if (outcome.kind === "ambiguous") {
    return {
      replyText: summarizeDiscordMatchAmbiguity(outcome.matches),
    };
  }

  if (outcome.kind === "role_assignment_failed") {
    return {
      replyText:
        "I could not assign your Discord role right now. Please ask the creator to check bot permissions and role hierarchy.",
    };
  }

  return {
    roleGranted: true,
    binding: outcome.binding,
    replyText: `Success - linked to Discord user \`${outcome.member.user.username}\` and applied your server role.`,
  };
}

async function processBindCommand({
  config,
  messageSenderUuid,
  fanUserUuid,
  fanHandle,
  discordInput,
  sourceMessageUuid,
}) {
  if (messageSenderUuid !== BIND_COMMAND_ALLOWED_USER_UUID) {
    return {
      replyText: `Only @${BIND_COMMAND_ALLOWED_HANDLE} can use \`/bind\`.`,
    };
  }

  const outcome = await bindDiscordAccount({
    config,
    fanUserUuid,
    fanHandle,
    discordInput,
    sourceMessageUuid,
    sourceCommandName: "bind",
    requestedByFanvueHandle: BIND_COMMAND_ALLOWED_HANDLE,
  });

  if (outcome.kind === "not_found") {
    return {
      replyText: `I couldn't find \`${outcome.normalizedInput}\` in the Discord server. Make sure to join the server first. [https://discord.gg/8wMr2mmaRF](https://discord.gg/8wMr2mmaRF). Please send the exact username or user ID.`,
    };
  }

  if (outcome.kind === "ambiguous") {
    return {
      replyText: summarizeDiscordMatchAmbiguity(outcome.matches),
    };
  }

  if (outcome.kind === "role_assignment_failed") {
    return {
      replyText:
        "I could not assign the Discord role right now. Please check bot permissions and role hierarchy.",
    };
  }

  return {
    roleGranted: true,
    binding: outcome.binding,
    replyText: `Success - linked fan \`${fanHandle}\` to Discord user \`${outcome.member.user.username}\` and applied the server role.`,
  };
}

function formatStats(stats) {
  return `chats=${stats.chatsScanned}, messages=${stats.messagesScanned}, commands=${stats.commandMessages}, rolesGranted=${stats.rolesGranted}, bindingsUpdated=${stats.bindingsUpdated}, failures=${stats.failures}`;
}

async function runSyncPass(config) {
  const stats = {
    chatsScanned: 0,
    messagesScanned: 0,
    commandMessages: 0,
    rolesGranted: 0,
    bindingsUpdated: 0,
    failures: 0,
  };

  const tokenRecord = await getValidAccessToken(config);
  const accessToken = tokenRecord.accessToken;

  const chats = await listRecentChats(config, accessToken);
  stats.chatsScanned = chats.length;

  const store = await readDiscordBindingsStore();
  const processedMessageIds = new Set(store.processedMessageUuids);
  let storeChanged = false;

  for (const chat of chats) {
    const fanUserUuid = chat.user.uuid;
    const messages = await listChatMessages(config, accessToken, fanUserUuid);

    for (const message of messages) {
      stats.messagesScanned += 1;

      if (processedMessageIds.has(message.uuid)) {
        // Messages are fetched newest-first, so older messages are already processed.
        break;
      }

      let shouldMarkMessageAsProcessed = true;

      const command = getDiscordCommandInput(message.text);
      if (command) {
        const isFanMessage = message.sender.uuid === fanUserUuid;
        const shouldHandleDiscordCommand = command.commandName === "discord" && isFanMessage;
        const shouldHandleBindCommand = command.commandName === "bind" && !isFanMessage;

        if (shouldHandleDiscordCommand || shouldHandleBindCommand) {
          stats.commandMessages += 1;

          try {
            const outcome = shouldHandleDiscordCommand
              ? await processDiscordCommand({
                  config,
                  accessToken,
                  fanUserUuid,
                  fanHandle: chat.user.handle,
                  discordInput: command.input,
                  sourceMessageUuid: message.uuid,
                })
              : await processBindCommand({
                  config,
                  messageSenderUuid: message.sender.uuid,
                  fanUserUuid,
                  fanHandle: chat.user.handle,
                  discordInput: command.input,
                  sourceMessageUuid: message.uuid,
                });

            if (outcome.replyText) {
              try {
                await sendFanvueReply(config, accessToken, fanUserUuid, outcome.replyText);
              } catch (replyError) {
                console.error(`Failed sending Fanvue reply to ${chat.user.handle}`, replyError);
              }
            }

            if (outcome.binding) {
              store.bindingsByFanvueUserUuid[fanUserUuid] = outcome.binding;
              stats.bindingsUpdated += 1;
              storeChanged = true;
            }

            if (outcome.roleGranted) {
              stats.rolesGranted += 1;
            }
          } catch (error) {
            stats.failures += 1;
            console.error(`Failed handling /${command.commandName} command in chat with fan ${chat.user.handle}`, error);
            shouldMarkMessageAsProcessed = false;
          }
        }
      }

      if (shouldMarkMessageAsProcessed && markMessageProcessed(store, message.uuid)) {
        processedMessageIds.add(message.uuid);
        storeChanged = true;
      }
    }
  }

  if (storeChanged) {
    await writeDiscordBindingsStore(store);
  }

  return stats;
}

async function runOnce(config) {
  const stats = await runSyncPass(config);
  console.log(`Sync pass complete: ${formatStats(stats)}`);
}

async function runForever(config) {
  console.log(`Starting Discord role sync worker (poll interval ${Math.floor(config.pollIntervalMs / 1000)}s).`);

  while (true) {
    const startedAt = Date.now();

    try {
      const stats = await runSyncPass(config);
      console.log(`[${new Date().toISOString()}] Sync pass complete: ${formatStats(stats)}`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Sync pass failed`, error);
    }

    const elapsed = Date.now() - startedAt;
    const sleepMs = Math.max(config.pollIntervalMs - elapsed, 1000);
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

