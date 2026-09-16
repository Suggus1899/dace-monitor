import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${name}.`);
  return value;
}

function port(value: string | undefined): number {
  const parsed = Number(value ?? "3000");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT debe ser un puerto válido.");
  }
  return parsed;
}

function url(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") throw new Error();
    return parsed.origin;
  } catch {
    throw new Error("APP_BASE_URL debe ser una URL HTTPS válida.");
  }
}

export const env = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramChatId: required("TELEGRAM_CHAT_ID"),
  unergUser: required("UNERG_USER"),
  unergPass: required("UNERG_PASS"),
  databaseUrl: required("DATABASE_URL"),
  credentialEncryptionKey: required("CREDENTIAL_ENCRYPTION_KEY"),
  appBaseUrl: url(required("APP_BASE_URL")),
  port: port(process.env.PORT),
} as const;
