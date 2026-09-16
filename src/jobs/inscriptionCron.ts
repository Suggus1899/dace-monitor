import cron, { type ScheduledTask } from "node-cron";
import type { DaceService } from "../services/daceService.js";
import type { TelegramService } from "../services/telegramService.js";

export function startInscriptionCron(dace: DaceService, telegram: TelegramService, chatId: string): ScheduledTask {
  let running = false;
  let lastAvailability: string | undefined;
  const run = async (): Promise<void> => {
    if (running) {
      console.warn("Inscription cron skipped: previous run is still active.");
      return;
    }
    running = true;
    try {
      const status = await dace.checkInscription();
      if (status.state === "open") {
        await telegram.bot.sendMessage(chatId, `🚨 INSCRIPCIONES ABIERTAS\n${status.detail}`);
      }
      const features = await dace.getAcademicAvailability();
      const available = features.filter((feature) => feature.available).map((feature) => feature.label);
      const availability = available.join("|");
      if (lastAvailability !== undefined && availability !== lastAvailability) {
        await telegram.bot.sendMessage(chatId, `🔔 DACE cambió las opciones disponibles: ${available.join(", ") || "ninguna opción adicional"}.`);
      }
      lastAvailability = availability;
      console.info(`Inscription check: ${status.state}`);
    } catch (error) {
      console.error("Inscription cron failed:", error);
      try {
        await telegram.bot.sendMessage(chatId, "⚠️ No se pudo verificar DACE en este intento. Revisaré nuevamente en 15 minutos.");
      } catch (telegramError) {
        console.error("Could not send cron failure alert:", telegramError);
      }
    } finally {
      running = false;
    }
  };

  const task = cron.schedule("*/15 * * * *", () => void run());
  void run();
  return task;
}
