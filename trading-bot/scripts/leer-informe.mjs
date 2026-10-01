// Descarga el último informe que el bot fijó en el chat de Telegram (cada día o con /informe).
// Lo usa Claude para aprender de la copia del celular. Uso, desde trading-bot/:
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/leer-informe.mjs [archivo.json]
import { writeFileSync } from "node:fs";

const API = process.env.TELEGRAM_API_URL ?? "https://api.telegram.org";
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
if (!token || !chat) throw new Error("Faltan TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID");
const call = async (method, params) => {
  const r = await (await fetch(`${API}/bot${token}/${method}?${new URLSearchParams(params)}`)).json();
  if (!r.ok) throw new Error(`${method}: ${r.description}`);
  return r.result;
};

const pinned = (await call("getChat", { chat_id: chat })).pinned_message;
if (!pinned?.document) throw new Error("No hay ningún informe fijado en el chat todavía (el bot lo publica cada día o con /informe)");
const { file_path } = await call("getFile", { file_id: pinned.document.file_id });
const text = await (await fetch(`${API}/file/bot${token}/${file_path}`)).text();
const report = JSON.parse(text);
const out = process.argv[2];
if (out) writeFileSync(out, text);
console.log(`Informe del ${report.generado} (${report.version ? `versión ${report.version.commit}` : "sin versión"})${out ? `, guardado en ${out}` : ""}`);
console.log(report.estado);
console.log(`${report.operaciones.length} operaciones guardadas, ${report.posiciones.length} abiertas, ${report.registro.length} líneas de registro`);
