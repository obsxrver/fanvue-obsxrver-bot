import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";

export type OAuthTokenRecord = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType?: string;
  scope?: string;
  updatedAt: string;
};

const OAUTH_TOKEN_STORE_PATH = join(process.cwd(), "data", "oauth-token.json");

export async function readOAuthTokenRecord(): Promise<OAuthTokenRecord | null> {
  try {
    const raw = await readFile(OAUTH_TOKEN_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<OAuthTokenRecord>;

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
      expiresAt: parsed.expiresAt,
      tokenType: parsed.tokenType,
      scope: parsed.scope,
      updatedAt: parsed.updatedAt,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeOAuthTokenRecord(record: OAuthTokenRecord): Promise<void> {
  const storeDir = dirname(OAUTH_TOKEN_STORE_PATH);
  const tmpPath = `${OAUTH_TOKEN_STORE_PATH}.tmp`;

  await mkdir(storeDir, { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tmpPath, OAUTH_TOKEN_STORE_PATH);
}

