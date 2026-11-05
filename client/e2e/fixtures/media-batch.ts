import { randomInt } from "node:crypto";

const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
/** Test-authored diagnostic cards, not generated product artwork. Codes occur
 * only inside pixels/PDF text, never in the user request or attachment names. */
export async function mediaBatchFixture() {
  // pdf-parse installs this optional native helper. Load it only after the
  // live-test opt-in, so normal test collection needs no native canvas binary.
  const { createCanvas } = await import("@napi-rs/canvas");
  const images = Array.from({ length: 10 }, (_, i) => {
    const number = i + 1, token = code(), canvas = createCanvas(600, 360), ctx = canvas.getContext("2d");
    ctx.fillStyle = `hsl(${i * 32}, 45%, 92%)`; ctx.fillRect(0, 0, 600, 360);
    ctx.fillStyle = "#24313b"; ctx.font = "bold 50px sans-serif"; ctx.fillText(`IMAGE ${String(number).padStart(2, "0")}`, 42, 100);
    ctx.font = "bold 54px monospace"; ctx.fillText(token, 42, 220);
    ctx.font = "24px sans-serif"; ctx.fillText("TaroCub attachment acceptance", 42, 310);
    return { number, code: token, name: `image-${String(number).padStart(2, "0")}.png`, mimeType: "image/png", buffer: canvas.toBuffer("image/png") };
  });
  const pdfCode = code(), stream = `BT /F1 24 Tf 40 160 Td (PDF_CODE: ${pdfCode}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body = "%PDF-1.4\n"; const offsets: number[] = [];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { images, pdfCode, pdf: { name: "batch-reference.pdf", mimeType: "application/pdf", buffer: Buffer.from(body) } };
}
