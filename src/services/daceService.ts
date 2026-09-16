import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { wrapper } from "axios-cookiejar-support";
import * as cheerio from "cheerio";
import { CookieJar } from "tough-cookie";
import { PDFParse } from "pdf-parse";

const BASE_URL = "https://cde.unerg.edu.ve";
const LOGIN_PAGE = "/auth/login/";
const LOGIN_POST = "/auth/";
const INSCRIPTIONS = "/estudiantes/inscripciones/";
const PENSUM = "/reporte/pensumestudiante/";
const GRADES = "/reporte/calificacion/";
const CLOSED_TEXT = "no hay ningún proceso de inscripción activo";
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export type InscriptionStatus = {
  state: "open" | "closed";
  detail: string;
  checkedAt: Date;
};

export type DownloadedDocument = {
  buffer: Buffer;
  fileName: string;
};

export type GradeTable = {
  text: string;
  structured: boolean;
};

export class DaceError extends Error {
  constructor(
    readonly code: "AUTH_FAILED" | "UPSTREAM_UNAVAILABLE" | "UNEXPECTED_CONTENT" | "PDF_PARSE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "DaceError";
  }
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("es-VE");
}

export function isClosedInscriptionHtml(html: string): boolean {
  return normalize(cheerio.load(html).text()).includes(CLOSED_TEXT);
}

export function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

export function formatGradeTable(rows: string[][]): string {
  const cleaned = rows
    .map((row) => row.map((cell) => cell.replace(/\s+/g, " ").trim()).filter(Boolean))
    .filter((row) => row.length > 0);
  if (!cleaned.length) return "No fue posible extraer una tabla legible del PDF.";

  const widths = cleaned.reduce<number[]>((current, row) => {
    row.forEach((cell, index) => {
      current[index] = Math.min(32, Math.max(current[index] ?? 0, cell.length));
    });
    return current;
  }, []);
  return cleaned
    .map((row) => row.map((cell, index) => cell.slice(0, widths[index]).padEnd(widths[index])).join(" | "))
    .join("\n");
}

function responseUrl(response: AxiosResponse): string {
  return response.request?.res?.responseUrl ?? response.config.url ?? "";
}

function extractCsrf(html: string): string {
  const token = cheerio.load(html)("input[name='csrfmiddlewaretoken']").first().val();
  if (typeof token !== "string" || !token) {
    throw new DaceError("UNEXPECTED_CONTENT", "DACE no entregó el token de inicio de sesión.");
  }
  return token;
}

function isAuthenticated(response: AxiosResponse<string>): boolean {
  const url = responseUrl(response);
  return response.status === 200 && url.includes("/estudiantes/") && response.data.includes("Salir del Sistema");
}

function asBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data as string);
}

function findTableRows(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length >= 2 && value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string" || typeof cell === "number"))) {
    return value.map((row) => (row as Array<string | number>).map(String));
  }
  for (const item of value) {
    const found = findTableRows(item);
    if (found) return found;
  }
  return undefined;
}

export class DaceService {
  constructor(
    private readonly credentials: { user: string; pass: string },
  ) {}

  private client(): AxiosInstance {
    const jar = new CookieJar();
    return wrapper(axios.create({
      baseURL: BASE_URL,
      jar,
      timeout: 25_000,
      maxRedirects: 5,
      maxContentLength: MAX_DOCUMENT_BYTES,
      maxBodyLength: MAX_DOCUMENT_BYTES,
      validateStatus: () => true,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; DaceUnergTelegramMonitor/1.0)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }));
  }

  private async authenticatedClient(): Promise<AxiosInstance> {
    const client = this.client();
    let loginPage: AxiosResponse<string>;
    try {
      loginPage = await client.get<string>(LOGIN_PAGE);
    } catch {
      throw new DaceError("UPSTREAM_UNAVAILABLE", "No fue posible conectar con DACE.");
    }
    if (loginPage.status !== 200) {
      throw new DaceError("UPSTREAM_UNAVAILABLE", "DACE respondió con un error al abrir el login.");
    }

    const csrf = extractCsrf(loginPage.data);
    const form = new URLSearchParams({
      csrfmiddlewaretoken: csrf,
      username: this.credentials.user,
      password: this.credentials.pass,
      next: "/estudiantes/",
      entrar: "Iniciar Sesión",
    });

    let login: AxiosResponse<string>;
    try {
      login = await client.post<string>(LOGIN_POST, form, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: `${BASE_URL}${LOGIN_PAGE}`,
          "X-CSRFToken": csrf,
        },
      });
    } catch {
      throw new DaceError("UPSTREAM_UNAVAILABLE", "DACE no respondió durante el inicio de sesión.");
    }
    if (!isAuthenticated(login)) {
      throw new DaceError("AUTH_FAILED", "DACE rechazó las credenciales o cambió el flujo de inicio de sesión.");
    }
    return client;
  }

  async checkInscription(): Promise<InscriptionStatus> {
    const client = await this.authenticatedClient();
    let response: AxiosResponse<string>;
    try {
      response = await client.get<string>(INSCRIPTIONS, { headers: { Referer: `${BASE_URL}/estudiantes/` } });
    } catch {
      throw new DaceError("UPSTREAM_UNAVAILABLE", "DACE no respondió al consultar inscripciones.");
    }
    if (!isAuthenticated(response)) {
      throw new DaceError("UNEXPECTED_CONTENT", "DACE devolvió una página no autenticada al consultar inscripciones.");
    }
    const detail = cheerio.load(response.data)(".inscripciones").text().replace(/\s+/g, " ").trim()
      || cheerio.load(response.data)("body").text().replace(/\s+/g, " ").trim();
    return {
      state: isClosedInscriptionHtml(response.data) ? "closed" : "open",
      detail,
      checkedAt: new Date(),
    };
  }

  private async download(path: string, fileName: string): Promise<DownloadedDocument> {
    const client = await this.authenticatedClient();
    let response: AxiosResponse<ArrayBuffer>;
    try {
      response = await client.get<ArrayBuffer>(path, {
        responseType: "arraybuffer",
        headers: { Referer: `${BASE_URL}/estudiantes/` },
      });
    } catch {
      throw new DaceError("UPSTREAM_UNAVAILABLE", "DACE no respondió al generar el documento.");
    }
    const buffer = asBuffer(response.data);
    const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
    if (response.status !== 200 || (!contentType.includes("pdf") && !isPdfBuffer(buffer)) || !isPdfBuffer(buffer)) {
      throw new DaceError("UNEXPECTED_CONTENT", "DACE no devolvió un PDF válido.");
    }
    return { buffer, fileName };
  }

  downloadPensum(): Promise<DownloadedDocument> {
    return this.download(PENSUM, "pensum.pdf");
  }

  downloadGrades(): Promise<DownloadedDocument> {
    return this.download(GRADES, "notas.pdf");
  }

  async extractGradesTable(buffer: Buffer): Promise<GradeTable> {
    const parser = new PDFParse({ data: buffer });
    try {
      const tableResult = await parser.getTable();
      const rows = findTableRows(JSON.parse(JSON.stringify(tableResult)));
      if (rows) return { text: formatGradeTable(rows), structured: true };

      const textResult = await parser.getText();
      return { text: textResult.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(), structured: false };
    } catch {
      throw new DaceError("PDF_PARSE_FAILED", "No fue posible leer las calificaciones del PDF.");
    } finally {
      await parser.destroy();
    }
  }
}
