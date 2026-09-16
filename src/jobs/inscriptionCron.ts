import cron, { type ScheduledTask } from "node-cron";
import { DaceService } from "../services/daceService.js";
import type { AccountStore } from "../services/accountStore.js";
import type { TelegramService } from "../services/telegramService.js";

export function daceHealthTransition(wasUnavailable: boolean, failed: boolean): "down" | "recovered" | undefined {
  if (failed) return wasUnavailable ? undefined : "down";
  return wasUnavailable ? "recovered" : undefined;
}

export function startInscriptionCron(accounts: AccountStore, telegram: TelegramService): ScheduledTask {
  let running = false;
  const lastAvailability = new Map<string, string>();
  const unavailableChats = new Set<string>();
  const sendAlert = async (chatId: string, message: string): Promise<void> => {
    try {
      await telegram.bot.sendMessage(chatId, message);
    } catch (error) {
      console.error("Could not send cron alert:", error);
    }
  };
  const checkAccount = async (chatId: string, user: string, pass: string): Promise<void> => {
    try {
      const dace = new DaceService({ user, pass });
      const status = await dace.checkInscription();
      const features = await dace.getAcademicAvailability();
      const available = features.filter((feature) => feature.available).map((feature) => feature.label);
      const availability = available.join("|");
      const healthAlert = daceHealthTransition(unavailableChats.has(chatId), false);
      unavailableChats.delete(chatId);
      if (healthAlert === "recovered") {
        await sendAlert(chatId, "✅ DACE volvió a estar disponible.");
      }
      if (status.state === "open" && await accounts.shouldNotifyInscription(chatId)) {
        await sendAlert(chatId, `🚨 INSCRIPCIONES ABIERTAS\n${status.detail}`);
      }
      if (lastAvailability.has(chatId) && availability !== lastAvailability.get(chatId)) {
        await sendAlert(chatId, `🔔 DACE cambió las opciones disponibles: ${available.join(", ") || "ninguna opción adicional"}.`);
      }
      lastAvailability.set(chatId, availability);
      console.info(`Inscription check for ${chatId}: ${status.state}`);
    } catch (error) {
      console.error(`Inscription cron failed for ${chatId}:`, error);
      const healthAlert = daceHealthTransition(unavailableChats.has(chatId), true);
      unavailableChats.add(chatId);
      if (healthAlert === "down") {
        await sendAlert(chatId, "⚠️ DACE no está disponible o no fue posible iniciar sesión. Avisaré cuando se recupere.");
      }
    }
  };

  const run = async (): Promise<void> => {
    if (running) {
      console.warn("Inscription cron skipped: previous run is still active.");
      return;
    }
    running = true;
    try {
      // ponytail: checks are sequential; add bounded concurrency only when the user count makes a run exceed 15 minutes.
      for (const account of await accounts.allCredentials()) await checkAccount(account.chatId, account.user, account.pass);
    } finally {
      running = false;
    }
  };

  const task = cron.schedule("*/15 * * * *", () => void run());
  void run();
  return task;
}
