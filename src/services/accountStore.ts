import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { type AlertFrequency, type AlertPreferencesSnapshot, isQuietHour } from "./alertPreferences.js";
import { CredentialCipher } from "./credentialCipher.js";

export interface AccountCredentials {
  chatId: string;
  user: string;
  pass: string;
}

const DEFAULT_PREFERENCES: AlertPreferencesSnapshot = { inscriptionsEnabled: true, frequency: 15, quietHoursEnabled: false };

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function caracasHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Caracas", hour: "numeric", hourCycle: "h23" }).format(now));
}

function toPreferences(row: { inscriptions_enabled: boolean; alert_frequency: number; quiet_hours_enabled: boolean }): AlertPreferencesSnapshot {
  return { inscriptionsEnabled: row.inscriptions_enabled, frequency: row.alert_frequency as AlertFrequency, quietHoursEnabled: row.quiet_hours_enabled };
}

export class AccountStore {
  private readonly pool: Pool;
  private readonly cipher: CredentialCipher;

  constructor(databaseUrl: string, encryptionKey: string) {
    this.pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
    this.cipher = new CredentialCipher(encryptionKey);
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        chat_id TEXT PRIMARY KEY, user_ciphertext TEXT NOT NULL, pass_ciphertext TEXT NOT NULL,
        inscriptions_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        alert_frequency SMALLINT NOT NULL DEFAULT 15 CHECK (alert_frequency IN (15, 30, 60)),
        quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        last_inscription_alert_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS connection_tokens (
        token_hash TEXT PRIMARY KEY, chat_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
      );
    `);
  }

  async close(): Promise<void> { await this.pool.end(); }

  async saveCredentials(chatId: string, user: string, pass: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO accounts (chat_id, user_ciphertext, pass_ciphertext) VALUES ($1, $2, $3)
      ON CONFLICT (chat_id) DO UPDATE SET user_ciphertext = EXCLUDED.user_ciphertext, pass_ciphertext = EXCLUDED.pass_ciphertext, updated_at = NOW()
    `, [chatId, this.cipher.encrypt(user), this.cipher.encrypt(pass)]);
  }

  async credentials(chatId: string): Promise<AccountCredentials | undefined> {
    const result = await this.pool.query<{ user_ciphertext: string; pass_ciphertext: string }>("SELECT user_ciphertext, pass_ciphertext FROM accounts WHERE chat_id = $1", [chatId]);
    const row = result.rows[0];
    return row && { chatId, user: this.cipher.decrypt(row.user_ciphertext), pass: this.cipher.decrypt(row.pass_ciphertext) };
  }

  async allCredentials(): Promise<AccountCredentials[]> {
    const result = await this.pool.query<{ chat_id: string; user_ciphertext: string; pass_ciphertext: string }>("SELECT chat_id, user_ciphertext, pass_ciphertext FROM accounts");
    return result.rows.map((row) => ({ chatId: row.chat_id, user: this.cipher.decrypt(row.user_ciphertext), pass: this.cipher.decrypt(row.pass_ciphertext) }));
  }

  async deleteAccount(chatId: string): Promise<void> {
    await this.pool.query("DELETE FROM connection_tokens WHERE chat_id = $1", [chatId]);
    await this.pool.query("DELETE FROM accounts WHERE chat_id = $1", [chatId]);
  }

  async createConnectionToken(chatId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.pool.query("DELETE FROM connection_tokens WHERE chat_id = $1 OR expires_at <= NOW()", [chatId]);
    await this.pool.query("INSERT INTO connection_tokens (token_hash, chat_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')", [tokenHash(token), chatId]);
    return token;
  }

  async connectionChatId(token: string): Promise<string | undefined> {
    const result = await this.pool.query<{ chat_id: string }>("SELECT chat_id FROM connection_tokens WHERE token_hash = $1 AND expires_at > NOW()", [tokenHash(token)]);
    return result.rows[0]?.chat_id;
  }

  async consumeConnectionToken(token: string): Promise<string | undefined> {
    const result = await this.pool.query<{ chat_id: string }>("DELETE FROM connection_tokens WHERE token_hash = $1 AND expires_at > NOW() RETURNING chat_id", [tokenHash(token)]);
    return result.rows[0]?.chat_id;
  }

  async consumeConnectionTokenAndSaveCredentials(token: string, user: string, pass: string): Promise<string | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tokenResult = await client.query<{ chat_id: string }>("DELETE FROM connection_tokens WHERE token_hash = $1 AND expires_at > NOW() RETURNING chat_id", [tokenHash(token)]);
      const chatId = tokenResult.rows[0]?.chat_id;
      if (!chatId) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query(`
        INSERT INTO accounts (chat_id, user_ciphertext, pass_ciphertext) VALUES ($1, $2, $3)
        ON CONFLICT (chat_id) DO UPDATE SET user_ciphertext = EXCLUDED.user_ciphertext, pass_ciphertext = EXCLUDED.pass_ciphertext, updated_at = NOW()
      `, [chatId, this.cipher.encrypt(user), this.cipher.encrypt(pass)]);
      await client.query("COMMIT");
      return chatId;
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: unknown) => console.error("Could not roll back connection transaction:", rollbackError));
      throw error;
    } finally {
      client.release();
    }
  }

  async preferences(chatId: string): Promise<AlertPreferencesSnapshot> {
    const result = await this.pool.query<{ inscriptions_enabled: boolean; alert_frequency: number; quiet_hours_enabled: boolean }>("SELECT inscriptions_enabled, alert_frequency, quiet_hours_enabled FROM accounts WHERE chat_id = $1", [chatId]);
    return result.rows[0] ? toPreferences(result.rows[0]) : DEFAULT_PREFERENCES;
  }

  async updatePreferences(chatId: string, preferences: AlertPreferencesSnapshot): Promise<void> {
    await this.pool.query("UPDATE accounts SET inscriptions_enabled = $2, alert_frequency = $3, quiet_hours_enabled = $4, updated_at = NOW() WHERE chat_id = $1", [chatId, preferences.inscriptionsEnabled, preferences.frequency, preferences.quietHoursEnabled]);
  }

  async shouldNotifyInscription(chatId: string, now = new Date()): Promise<boolean> {
    const preferences = await this.preferences(chatId);
    if (!preferences.inscriptionsEnabled || (preferences.quietHoursEnabled && isQuietHour(caracasHour(now)))) return false;
    const result = await this.pool.query<{ last_inscription_alert_at: Date | null; alert_frequency: number }>(
      "SELECT last_inscription_alert_at, alert_frequency FROM accounts WHERE chat_id = $1",
      [chatId],
    );
    const row = result.rows[0];
    if (!row || row.last_inscription_alert_at === null) return Boolean(row);
    return now.getTime() - row.last_inscription_alert_at.getTime() >= row.alert_frequency * 60_000;
  }

  async markInscriptionNotified(chatId: string, now = new Date()): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE accounts SET last_inscription_alert_at = $2
      WHERE chat_id = $1 AND (last_inscription_alert_at IS NULL OR last_inscription_alert_at <= $2 - (alert_frequency * INTERVAL '1 minute'))
      RETURNING chat_id
    `, [chatId, now]);
    return result.rowCount === 1;
  }
}
