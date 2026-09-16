import cron, { type ScheduledTask } from "node-cron";
import type { DaceService } from "../services/daceService.js";
import type { TelegramService } from "../services/telegramService.js";

export function daceHealthTransition(wasUnavailable: boolean, failed: boolean): "down" | "recovered" | undefined {
  if (failed) return wasUnavailable ? undefined : "down";
  return wasUnavailable ? "recovered" : undefined;
}

export function startInscriptionCron(dace: DaceService, telegram: TelegramService, chatId: string): ScheduledTask {
  let running = false;
  let lastAvailability: string | undefined;
  let daceWasUnavailable = false;
  const sendAlert = async (message: string): Promise<void> => {
    try {
      await telegram.bot.sendMessage(chatId, message);
    } catch (error) {
      console.error("Could not send cron alert:", error);
    }
  };
  const run = async (): Promise<void> => {
    if (running) {
      console.warn("Inscription cron skipped: previous run is still active.");
      return;
    }
    running = true;
    try {
      const status = await dace.checkInscription();
      const features = await dace.getAcademicAvailability();
      const available = features.filter((feature) => feature.available).map((feature) => feature.label);
      const availability = available.join("|");
      const healthAlert = daceHealthTransition(daceWasUnavailable, false);
      daceWasUnavailable = false;
      if (healthAlert === "recovered") {
        await sendAlert("✅ DACE volvió a estar disponible.");
      }
      if (status.state === "open") {
        await sendAlert(`🚨 INSCRIPCIONES ABIERTAS\n${status.detail}`);
      }
      if (lastAvailability !== undefined && availability !== lastAvailability) {
        await sendAlert(`🔔 DACE cambió las opciones disponibles: ${available.join(", ") || "ninguna opción adicional"}.`);
      }
      lastAvailability = availability;
      console.info(`Inscription check: ${status.state}`);
    } catch (error) {
      console.error("Inscription cron failed:", error);
      const healthAlert = daceHealthTransition(daceWasUnavailable, true);
      daceWasUnavailable = true;
      if (healthAlert === "down") {
        await sendAlert("⚠️ DACE no está disponible o no fue posible iniciar sesión. Avisaré cuando se recupere.");
      }
    } finally {
      running = false;
    }
  };

  const task = cron.schedule("*/15 * * * *", () => void run());
  void run();
  return task;
}
