import { createServer } from "node:http";
import { env } from "./config/env.js";
import { startInscriptionCron } from "./jobs/inscriptionCron.js";
import { DaceService } from "./services/daceService.js";
import { TelegramService } from "./services/telegramService.js";

const dace = new DaceService({ user: env.unergUser, pass: env.unergPass });
const telegram = new TelegramService(env.telegramBotToken, env.telegramChatId, dace);
telegram.start();
const task = startInscriptionCron(dace, telegram, env.telegramChatId);

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(env.port, () => console.info(`Health server listening on port ${env.port}.`));

async function shutdown(signal: string): Promise<void> {
  console.info(`${signal} received; shutting down.`);
  task.stop();
  await telegram.stop();
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
