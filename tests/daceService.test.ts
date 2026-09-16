import assert from "node:assert/strict";
import test from "node:test";
import { formatGradeTable, inscriptionDetail, isClosedInscriptionHtml, isPdfBuffer } from "../src/services/daceService.js";

test("detecta el estado cerrado y no confunde otro HTML con cerrado", () => {
  const closedHtml = "<p>No hay ningún proceso de inscripción activo para INGENIERIA.</p><nav>Inicio Calificaciones</nav><script>codigo()</script>";
  assert.equal(isClosedInscriptionHtml(closedHtml), true);
  assert.equal(inscriptionDetail(closedHtml, "closed"), "No hay ningún proceso de inscripción activo para INGENIERIA.");
  assert.equal(isClosedInscriptionHtml("<html><body>Perfil del Estudiante</body></html>"), false);
});

test("valida PDF y formatea filas para Telegram", () => {
  assert.equal(isPdfBuffer(Buffer.from("%PDF-1.7")), true);
  assert.equal(isPdfBuffer(Buffer.from("<html>login</html>")), false);
  assert.match(formatGradeTable([["Materia", "Nota"], ["Programación", "20"]]), /Programación/);
});
