import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { env } from "./config/env.js";
import { startInscriptionCron } from "./jobs/inscriptionCron.js";
import { AccountStore } from "./services/accountStore.js";
import { DaceService } from "./services/daceService.js";
import { TelegramService } from "./services/telegramService.js";

function html(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(title: string, content: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:440px;margin:8vh auto;padding:24px;color:#172033}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;font:inherit}button{background:#18864b;color:white;border:0;border-radius:6px}small{color:#596275}</style></head><body>${content}</body></html>`;
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

async function formBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 10_000) throw new Error("Formulario demasiado grande.");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const accounts = new AccountStore(env.databaseUrl, env.credentialEncryptionKey);
await accounts.init();
if (!await accounts.credentials(env.telegramChatId)) {
  await accounts.saveCredentials(env.telegramChatId, env.unergUser, env.unergPass);
}

const telegram = new TelegramService(env.telegramBotToken, accounts, env.appBaseUrl);
telegram.start();
const task = startInscriptionCron(accounts, telegram);

const server = createServer((request, response) => void (async () => {
  const requestUrl = new URL(request.url ?? "/", env.appBaseUrl);
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/connect") {
    const token = requestUrl.searchParams.get("token") ?? "";
    if (!await accounts.connectionChatId(token)) {
      sendHtml(response, 400, page("Enlace vencido", "<h1>Enlace vencido</h1><p>Vuelve a Telegram y usa /conectar para generar otro.</p>"));
      return;
    }
    sendHtml(response, 200, page("Conectar DACE", `<h1>Conectar DACE</h1><p>Las credenciales se cifran antes de guardarse.</p><form method="post" action="/connect"><input type="hidden" name="token" value="${html(token)}"><label>Correo o usuario<input name="user" autocomplete="username" required maxlength="320"></label><label>Contraseña<input type="password" name="pass" autocomplete="current-password" required maxlength="512"></label><button type="submit">Conectar</button></form><small>Este enlace vence en 10 minutos. No compartas esta página.</small>`));
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/connect") {
    const body = await formBody(request);
    const token = body.get("token") ?? "";
    const user = body.get("user")?.trim() ?? "";
    const pass = body.get("pass") ?? "";
    if (!user || !pass || user.length > 320 || pass.length > 512 || !await accounts.connectionChatId(token)) {
      sendHtml(response, 400, page("No se pudo conectar", "<h1>No se pudo conectar</h1><p>El enlace es inválido o venció. Usa /conectar en Telegram e inténtalo de nuevo.</p>"));
      return;
    }
    try {
      await new DaceService({ user, pass }).checkInscription();
      const chatId = await accounts.consumeConnectionToken(token);
      if (!chatId) throw new Error("El enlace ya fue utilizado.");
      await accounts.saveCredentials(chatId, user, pass);
      await telegram.bot.sendMessage(chatId, "✅ Tu cuenta DACE fue conectada. Usa /start para ver las opciones.");
      sendHtml(response, 200, page("Cuenta conectada", "<h1>Cuenta conectada</h1><p>Regresa a Telegram y usa /start.</p>"));
    } catch {
      sendHtml(response, 401, page("No se pudo conectar", "<h1>No se pudo conectar</h1><p>DACE rechazó las credenciales o no está disponible. Vuelve a intentar más tarde con un enlace nuevo.</p>"));
    }
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
})().catch((error: unknown) => {
  console.error("HTTP request failed:", error);
  if (!response.headersSent) sendHtml(response, 500, page("Error temporal", "<h1>Error temporal</h1><p>Intenta nuevamente más tarde.</p>"));
  else response.end();
}));

server.listen(env.port, () => console.info(`Health server listening on port ${env.port}.`));

async function shutdown(signal: string): Promise<void> {
  console.info(`${signal} received; shutting down.`);
  task.stop();
  await telegram.stop();
  await accounts.close();
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
