import TelegramBot, { type CallbackQuery } from "node-telegram-bot-api";
import type { AccountStore } from "./accountStore.js";
import type { AlertFrequency, AlertPreferencesSnapshot } from "./alertPreferences.js";
import { DaceService, type AcademicFeature, type DaceError, type DownloadedDocument, type GradeTable, type InscriptionStatus } from "./daceService.js";

const MAX_MESSAGE_LENGTH = 3_800;

function chunks(text: string): string[] {
  if (!text) return ["El PDF no contiene texto extraíble."];
  const result: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    const cut = Math.max(remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH), remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH));
    result.push(remaining.slice(0, cut > 0 ? cut : MAX_MESSAGE_LENGTH));
    remaining = remaining.slice(cut > 0 ? cut : MAX_MESSAGE_LENGTH).trimStart();
  }
  result.push(remaining);
  return result;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function userError(error: unknown): string {
  const code = (error as DaceError | undefined)?.code;
  if (code === "AUTH_FAILED") return "DACE rechazó tus credenciales. Usa /conectar para actualizarlas.";
  if (code === "UPSTREAM_UNAVAILABLE") return "DACE no está disponible ahora. Intenta más tarde.";
  if (code === "PDF_PARSE_FAILED") return "Envié el PDF, pero no pude convertir sus notas en tabla.";
  return "DACE devolvió una respuesta inesperada. Intenta nuevamente más tarde.";
}

function formatAvailability(features: AcademicFeature[]): string {
  const available = features.filter((feature) => feature.available).map((feature) => feature.label);
  const unavailable = features.filter((feature) => !feature.available).map((feature) => feature.label);
  return [`Disponible: ${available.join(", ") || "ninguna opción adicional"}.`, `Sin período activo: ${unavailable.join(", ") || "ninguna"}.`].join("\n");
}

function formatPreferences(preferences: AlertPreferencesSnapshot): string {
  return [
    "Alertas de inscripciones",
    `Estado: ${preferences.inscriptionsEnabled ? "activadas" : "pausadas"}.`,
    `Frecuencia: cada ${preferences.frequency} minutos mientras estén abiertas.`,
    `Silencio nocturno (22:00–06:59 Caracas): ${preferences.quietHoursEnabled ? "activado" : "desactivado"}.`,
  ].join("\n");
}

export function preferencesForAlertArgument(preferences: AlertPreferencesSnapshot, argument: string): AlertPreferencesSnapshot | undefined {
  const option = argument.trim().toLowerCase();
  if (option === "activar" || option === "on") return { ...preferences, inscriptionsEnabled: true };
  if (option === "pausar" || option === "desactivar" || option === "off") return { ...preferences, inscriptionsEnabled: false };
  if (option === "noche") return { ...preferences, quietHoursEnabled: !preferences.quietHoursEnabled };
  if (["15", "30", "60"].includes(option)) return { ...preferences, frequency: Number(option) as AlertFrequency };
  return undefined;
}

export class TelegramService {
  readonly bot: TelegramBot;

  constructor(token: string, private readonly accounts: AccountStore, private readonly appBaseUrl: string) {
    this.bot = new TelegramBot(token, { polling: true });
  }

  private async requirePrivateChat(chatId: number, chatType: string): Promise<boolean> {
    if (chatType === "private") return true;
    await this.bot.sendMessage(chatId, "Por privacidad, este bot solo funciona en el chat privado con el bot.");
    return false;
  }

  private runHandler(name: string, handler: () => Promise<void>): void {
    void handler().catch(async (error: unknown) => {
      console.error(`Telegram handler failed: ${name}:`, error);
    });
  }

  start(): void {
    void this.bot.setMyCommands([
      { command: "start", description: "Abrir el menú" },
      { command: "conectar", description: "Conectar tu cuenta DACE" },
      { command: "desconectar", description: "Eliminar cuenta guardada" },
      { command: "estado", description: "Ver estado de DACE" },
      { command: "inscripcion", description: "Consultar inscripciones" },
      { command: "ping", description: "Comprobar bot y DACE" },
      { command: "alertas", description: "Configurar alertas" },
      { command: "pensum", description: "Descargar Pénsum" },
      { command: "constancia_notas", description: "Descargar constancia de notas" },
      { command: "notas", description: "Ver notas" },
      { command: "ayuda", description: "Ver ayuda" },
    ]).catch((error: Error) => console.error("Could not set Telegram commands:", error.message));
    this.bot.onText(/^\/start(?:@\w+)?$/, (message) => this.runHandler("start", () => this.startCommand(message.chat.id, message.chat.type)));
    this.bot.onText(/^\/conectar(?:@\w+)?$/, (message) => this.runHandler("connect", () => this.connectCommand(message.chat.id, message.chat.type)));
    this.bot.onText(/^\/desconectar(?:@\w+)?$/, (message) => this.runHandler("disconnect", () => this.disconnectCommand(message.chat.id, message.chat.type)));
    this.bot.onText(/^\/(inscripcion|pensum|constancia_notas|notas|estado|ping|alertas|ayuda)(?:@\w+)?(?:\s+(.+))?$/, (message, match) => this.runHandler("command", () => this.command(message.chat.id, message.chat.type, match?.[1], match?.[2])));
    this.bot.on("callback_query", (query) => this.runHandler("callback", () => this.callback(query)));
    this.bot.on("polling_error", (error) => console.error("Telegram polling error:", error.message));
  }

  async stop(): Promise<void> { await this.bot.stopPolling(); }

  private async dace(chatId: number): Promise<DaceService | undefined> {
    const credentials = await this.accounts.credentials(String(chatId));
    if (!credentials) {
      await this.bot.sendMessage(chatId, "Primero conecta tu cuenta de DACE con /conectar.");
      return undefined;
    }
    return new DaceService(credentials);
  }

  private async startCommand(chatId: number, chatType: string): Promise<void> {
    if (!await this.requirePrivateChat(chatId, chatType)) return;
    const connected = await this.accounts.credentials(String(chatId));
    await this.bot.sendMessage(chatId, connected ? "DACE UNERG: elige una consulta." : "Conecta tu cuenta de DACE para consultar tus datos de forma privada. Tus credenciales se cifran y puedes eliminarlas cuando quieras con /desconectar.", {
      reply_markup: {
        inline_keyboard: connected
          ? [
              [{ text: "Estado", callback_data: "status" }, { text: "Inscripción", callback_data: "inscription" }],
              [{ text: "Comprobar bot", callback_data: "ping" }, { text: "Alertas", callback_data: "alerts" }],
              [{ text: "Pénsum", callback_data: "pensum" }],
              [{ text: "Constancia de notas", callback_data: "grades-document" }, { text: "Notas", callback_data: "notes" }],
              [{ text: "Desconectar cuenta", callback_data: "disconnect" }],
            ]
          : [[{ text: "Conectar DACE", callback_data: "connect" }]],
      },
    });
  }

  private async connectCommand(chatId: number, chatType: string): Promise<void> {
    if (!await this.requirePrivateChat(chatId, chatType)) return;
    const token = await this.accounts.createConnectionToken(String(chatId));
    await this.bot.sendMessage(chatId, `Abre este enlace privado para conectar DACE:\n<a href="${this.appBaseUrl}/connect#token=${token}">🔐 Abrir enlace seguro</a>\n\nVence en 10 minutos. No envíes tus credenciales por Telegram.`, { parse_mode: "HTML" });
  }

  private async disconnectCommand(chatId: number, chatType: string): Promise<void> {
    if (!await this.requirePrivateChat(chatId, chatType)) return;
    await this.accounts.deleteAccount(String(chatId));
    await this.bot.sendMessage(chatId, "Tu cuenta y preferencias guardadas fueron eliminadas. Puedes volver a conectarte con /conectar.");
  }

  private async command(chatId: number, chatType: string, command: string | undefined, argument?: string): Promise<void> {
    if (!await this.requirePrivateChat(chatId, chatType)) return;
    if (command === "ayuda") {
      await this.bot.sendMessage(chatId, ["/conectar — conecta tu cuenta de forma segura.", "/desconectar — elimina tus credenciales guardadas.", "/estado, /inscripcion, /ping, /pensum, /constancia_notas, /notas", "/alertas — ver opciones; /alertas activar|pausar|15|30|60|noche"].join("\n"));
      return;
    }
    if (command === "alertas") return this.alertsCommand(chatId, argument);
    const dace = await this.dace(chatId);
    if (!dace) return;
    try {
      if (command === "estado") {
        const [inscription, features] = await Promise.all([dace.checkInscription(), dace.getAcademicAvailability()]);
        await this.bot.sendMessage(chatId, `Estado DACE\nInscripciones: ${inscription.state === "open" ? "🚨 ABIERTAS" : "Cerradas"}\n${inscription.detail}\n\n${formatAvailability(features)}`);
      } else if (command === "inscripcion") {
        const status: InscriptionStatus = await dace.checkInscription();
        await this.bot.sendMessage(chatId, status.state === "open" ? `🚨 INSCRIPCIONES ABIERTAS\n${status.detail}` : `Inscripciones cerradas.\n${status.detail}`);
      } else if (command === "ping") {
        const status = await dace.checkInscription();
        await this.bot.sendMessage(chatId, `✅ Bot y Render operativos.\n✅ DACE disponible.\nInscripciones: ${status.state === "open" ? "ABIERTAS" : "cerradas"}.`);
      } else if (command === "pensum") {
        await this.sendDocument(chatId, await dace.downloadPensum(), "Pénsum oficial DACE.");
      } else if (command === "constancia_notas") {
        const document = await dace.downloadGrades();
        await this.sendDocument(chatId, { ...document, fileName: "constancia-notas.pdf" }, "Constancia de notas oficial DACE.");
      } else if (command === "notas") {
        await this.notesCommand(chatId, dace);
      }
    } catch (error) {
      if (command === "ping") await this.bot.sendMessage(chatId, "✅ Bot y Render operativos.\n⚠️ DACE no está disponible ahora.");
      else await this.bot.sendMessage(chatId, userError(error));
    }
  }

  private async sendDocument(chatId: number, document: DownloadedDocument, caption: string): Promise<void> {
    await this.bot.sendDocument(chatId, document.buffer, { caption }, { filename: document.fileName, contentType: "application/pdf" });
  }

  private async notesCommand(chatId: number, dace: DaceService): Promise<void> {
    const document = await dace.downloadGrades();
    await this.sendDocument(chatId, document, "Reporte oficial de notas DACE.");
    let grades: GradeTable;
    try { grades = await dace.extractGradesTable(document.buffer); }
    catch (error) { await this.bot.sendMessage(chatId, userError(error)); return; }
    const heading = grades.structured ? "Tabla extraída del PDF:" : "Texto extraído del PDF:";
    for (const [index, part] of chunks(grades.text).entries()) {
      await this.bot.sendMessage(chatId, `${heading}${index ? " (continuación)" : ""}\n<pre>${escapeHtml(part)}</pre>`, { parse_mode: "HTML" });
    }
  }

  private async alertsCommand(chatId: number, argument?: string): Promise<void> {
    if (!await this.accounts.credentials(String(chatId))) {
      await this.bot.sendMessage(chatId, "Primero conecta tu cuenta de DACE con /conectar para configurar alertas.");
      return;
    }
    let preferences = await this.accounts.preferences(String(chatId));
    if (argument) {
      const next = preferencesForAlertArgument(preferences, argument);
      if (!next) {
        await this.bot.sendMessage(chatId, "Usa /alertas activar, /alertas pausar, /alertas 15, /alertas 30, /alertas 60 o /alertas noche.");
        return;
      }
      preferences = next;
      await this.accounts.updatePreferences(String(chatId), preferences);
    }
    await this.bot.sendMessage(chatId, formatPreferences(preferences), {
      reply_markup: {
        inline_keyboard: [
          [{ text: preferences.inscriptionsEnabled ? "Pausar inscripciones" : "Activar inscripciones", callback_data: "alerts-toggle" }],
          [15, 30, 60].map((frequency) => ({ text: `${preferences.frequency === frequency ? "✓ " : ""}${frequency} min`, callback_data: `alerts-frequency-${frequency}` })),
          [{ text: `${preferences.quietHoursEnabled ? "Desactivar" : "Activar"} silencio nocturno`, callback_data: "alerts-quiet" }],
        ],
      },
    });
  }

  private async callback(query: CallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id;
    if (chatId === undefined) return;
    if (query.message?.chat.type !== "private") {
      await this.bot.answerCallbackQuery(query.id, { text: "Usa el chat privado con el bot.", show_alert: true });
      return;
    }
    await this.bot.answerCallbackQuery(query.id);
    if (query.data === "connect") return this.connectCommand(chatId, "private");
    if (query.data === "disconnect") return this.disconnectCommand(chatId, "private");
    if (query.data === "alerts") return this.alertsCommand(chatId);
    if (query.data === "alerts-toggle" || query.data === "alerts-quiet" || query.data?.startsWith("alerts-frequency-")) {
      const current = await this.accounts.preferences(String(chatId));
      const frequency = Number(query.data?.replace("alerts-frequency-", "")) as AlertFrequency;
      const next = query.data === "alerts-toggle" ? { ...current, inscriptionsEnabled: !current.inscriptionsEnabled }
        : query.data === "alerts-quiet" ? { ...current, quietHoursEnabled: !current.quietHoursEnabled }
        : { ...current, frequency };
      await this.accounts.updatePreferences(String(chatId), next);
      return this.alertsCommand(chatId);
    }
    const commands: Record<string, string> = { inscription: "inscripcion", pensum: "pensum", "grades-document": "constancia_notas", notes: "notas", status: "estado", ping: "ping", help: "ayuda" };
    return this.command(chatId, "private", commands[query.data ?? ""]);
  }
}
