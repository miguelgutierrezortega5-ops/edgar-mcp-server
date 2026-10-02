// Configura Telegram paso a paso desde el teléfono, sin editar archivos: valida el token de
// @BotFather, detecta tu chat cuando le escribes a tu bot, lo guarda en .env y manda una prueba.
// Uso (desde trading-bot/): node scripts/android/telegram.mjs
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const API = process.env.TELEGRAM_API_URL ?? "https://api.telegram.org";
const call = async (token, method, params = {}) => {
  const r = await fetch(`${API}/bot${token}/${method}?${new URLSearchParams(params)}`);
  return r.json();
};
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log("Paso 1. En Telegram abre @BotFather, escribe /newbot, elige un nombre y copia el token que te da.");
const token = (await rl.question("Pega aquí el token: ")).trim();
rl.close();
if (!/^\d+:[\w-]+$/.test(token)) fail("Eso no parece un token (es como 123456789:ABC-def...). Vuelve a intentarlo con: bot telegram");
const me = await call(token, "getMe");
if (!me.ok) fail(`Telegram no acepta ese token: ${me.description}. Vuelve a intentarlo con: bot telegram`);

const bot = me.result.username;
console.log(`Token correcto: tu bot es @${bot}.`);
console.log(`Paso 2. Abre https://t.me/${bot}, pulsa "Iniciar" y escríbele cualquier cosa. Te espero 3 minutos...`);
let chat;
let offset = 0;
for (const end = Date.now() + 180_000; !chat && Date.now() < end; ) {
  const u = await call(token, "getUpdates", { timeout: 25, offset });
  if (!u.ok) fail(`Telegram respondió: ${u.description}. Si el bot ya usa este token, detenlo (bot detener) y repite.`);
  for (const { update_id, message } of u.result) {
    offset = update_id + 1;
    if (message?.chat?.type === "private") chat = message.chat;
  }
}
if (!chat) fail("No llegó ningún mensaje. Escríbele a tu bot y repite: bot telegram");

if (!existsSync(".env")) copyFileSync(".env.example", ".env");
let env = readFileSync(".env", "utf8");
for (const [k, v] of [["TELEGRAM_BOT_TOKEN", token], ["TELEGRAM_CHAT_ID", String(chat.id)]]) {
  const line = new RegExp(`^${k}=.*$`, "m");
  env = line.test(env) ? env.replace(line, () => `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
}
writeFileSync(".env", env);
await call(token, "getUpdates", { offset, timeout: 0 }); // marca tu mensaje como leído

const sent = await call(token, "sendMessage", {
  chat_id: chat.id,
  text: "Listo: aquí recibirás cada operación del bot de trading.\nComandos: /estado /pausa /reanudar /cerrar",
});
console.log(sent.ok ? `Guardado. ${chat.first_name ?? "Tu chat"} recibirá los avisos; te mandé un mensaje de prueba.` : `Guardado, pero el mensaje de prueba falló: ${sent.description}`);
