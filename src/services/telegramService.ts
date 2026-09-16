import TelegramBot, { type CallbackQuery } from "node-telegram-bot-api";
import type { DaceError, DaceService, DownloadedDocument, GradeTable, InscriptionStatus } from "./daceService.js";

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
  if (code === "AUTH_FAILED") return "DACE rechazó las credenciales. Revisa UNERG_USER y UNERG_PASS.";
  if (code === "UPSTREAM_UNAVAILABLE") return "DACE no está disponible ahora. Intenta más tarde.";
  if (code === "PDF_PARSE_FAILED") return "Envié el PDF, pero no pude convertir sus notas en tabla.";
  return "DACE devolvió una respuesta inesperada. Intenta nuevamente más tarde.";
}

export class TelegramService {
  readonly bot: TelegramBot;

  constructor(
    token: string,
    private readonly allowedChatId: string,
    private readonly dace: DaceService,
  ) {
    this.bot = new TelegramBot(token, { polling: true });
  }

  start(): void {
    this.bot.onText(/^\/start(?:@\w+)?$/, (message) => void this.startCommand(message.chat.id));
    this.bot.onText(/^\/inscripcion(?:@\w+)?$/, (message) => void this.inscriptionCommand(message.chat.id));
    this.bot.onText(/^\/pensum(?:@\w+)?$/, (message) => void this.pensumCommand(message.chat.id));
    this.bot.onText(/^\/constancia_notas(?:@\w+)?$/, (message) => void this.gradesDocumentCommand(message.chat.id));
    this.bot.onText(/^\/notas(?:@\w+)?$/, (message) => void this.notesCommand(message.chat.id));
    this.bot.on("callback_query", (query) => void this.callback(query));
    this.bot.on("polling_error", (error) => console.error("Telegram polling error:", error.message));
  }

  async stop(): Promise<void> {
    await this.bot.stopPolling();
  }

  private allowed(chatId: number | string): boolean {
    return String(chatId) === this.allowedChatId;
  }

  private async startCommand(chatId: number): Promise<void> {
    if (!this.allowed(chatId)) return;
    await this.bot.sendMessage(chatId, "DACE UNERG: elige una consulta.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Inscripción", callback_data: "inscription" }],
          [{ text: "Pénsum", callback_data: "pensum" }],
          [{ text: "Constancia de notas", callback_data: "grades-document" }],
          [{ text: "Notas", callback_data: "notes" }],
        ],
      },
    });
  }

  private async inscriptionCommand(chatId: number): Promise<void> {
    if (!this.allowed(chatId)) return;
    try {
      const status: InscriptionStatus = await this.dace.checkInscription();
      const message = status.state === "open"
        ? `🚨 INSCRIPCIONES ABIERTAS\n${status.detail}`
        : `Inscripciones cerradas.\n${status.detail}`;
      await this.bot.sendMessage(chatId, message);
    } catch (error) {
      await this.bot.sendMessage(chatId, userError(error));
    }
  }

  private async sendDocument(chatId: number, document: DownloadedDocument, caption: string): Promise<void> {
    await this.bot.sendDocument(chatId, document.buffer, { caption }, {
      filename: document.fileName,
      contentType: "application/pdf",
    });
  }

  private async pensumCommand(chatId: number): Promise<void> {
    if (!this.allowed(chatId)) return;
    try {
      await this.sendDocument(chatId, await this.dace.downloadPensum(), "Pénsum oficial DACE.");
    } catch (error) {
      await this.bot.sendMessage(chatId, userError(error));
    }
  }

  private async gradesDocumentCommand(chatId: number): Promise<void> {
    if (!this.allowed(chatId)) return;
    try {
      const document = await this.dace.downloadGrades();
      await this.sendDocument(chatId, { ...document, fileName: "constancia-notas.pdf" }, "Constancia de notas oficial DACE.");
    } catch (error) {
      await this.bot.sendMessage(chatId, userError(error));
    }
  }

  private async notesCommand(chatId: number): Promise<void> {
    if (!this.allowed(chatId)) return;
    try {
      const document = await this.dace.downloadGrades();
      await this.sendDocument(chatId, document, "Reporte oficial de notas DACE.");
      let grades: GradeTable;
      try {
        grades = await this.dace.extractGradesTable(document.buffer);
      } catch (error) {
        await this.bot.sendMessage(chatId, userError(error));
        return;
      }
      const heading = grades.structured ? "Tabla extraída del PDF:" : "Texto extraído del PDF:";
      for (const [index, part] of chunks(grades.text).entries()) {
        await this.bot.sendMessage(chatId, `${heading}${index ? " (continuación)" : ""}\n<pre>${escapeHtml(part)}</pre>`, {
          parse_mode: "HTML",
        });
      }
    } catch (error) {
      await this.bot.sendMessage(chatId, userError(error));
    }
  }

  private async callback(query: CallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id;
    if (chatId === undefined || !this.allowed(chatId)) return;
    await this.bot.answerCallbackQuery(query.id);
    switch (query.data) {
      case "inscription": return this.inscriptionCommand(chatId);
      case "pensum": return this.pensumCommand(chatId);
      case "grades-document": return this.gradesDocumentCommand(chatId);
      case "notes": return this.notesCommand(chatId);
      default: return;
    }
  }
}
