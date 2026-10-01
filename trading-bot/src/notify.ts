export type Notifier = (text: string) => Promise<void>;

const api = () => process.env.TELEGRAM_API_URL ?? "https://api.telegram.org";

/** Telegram notifications when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set; otherwise a no-op. */
export function telegramNotifier(enabled: boolean, log: (msg: string) => void): Notifier {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!enabled || !token || !chatId) return async () => {};
  return async (text) => {
    try {
      const res = await fetch(`${api()}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log(`Aviso: Telegram respondió ${res.status}`);
    } catch (err) {
      log(`Aviso: no se pudo enviar a Telegram: ${(err as Error).message}`);
    }
  };
}

export interface Command {
  name: string;
  args: string[];
}

/**
 * Reads commands sent to the Telegram bot (/estado, /pausa…). Only messages from TELEGRAM_CHAT_ID
 * are accepted, so nobody else who finds the bot can control it.
 */
export function telegramCommands(enabled: boolean, log: (msg: string) => void): (() => Promise<Command[]>) | undefined {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!enabled || !token || !chatId) return undefined;
  let offset = 0;
  let primed = false;
  return async () => {
    try {
      const res = await fetch(`${api()}/bot${token}/getUpdates?timeout=0&offset=${offset}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];
      const body = (await res.json()) as { result?: { update_id: number; message?: { chat?: { id: number }; text?: string } }[] };
      const out: Command[] = [];
      // Messages sent while the bot was off (an old "/cerrar todo") are discarded, not executed.
      const stale = !primed;
      primed = true;
      for (const u of body.result ?? []) {
        offset = Math.max(offset, u.update_id + 1);
        if (stale) continue;
        const text = u.message?.text?.trim();
        if (!text?.startsWith("/") || String(u.message?.chat?.id) !== chatId) continue;
        const [name, ...args] = text.split(/\s+/);
        out.push({ name: name.slice(1).split("@")[0].toLowerCase(), args });
      }
      return out;
    } catch (err) {
      log(`Aviso: no se pudieron leer los comandos de Telegram: ${(err as Error).message}`);
      return [];
    }
  };
}

/**
 * Sends a file to the owner's chat and pins it silently: the latest pinned file is the report Claude
 * reads (getChat → pinned_message). Undefined when Telegram is not configured.
 */
export function telegramReporter(enabled: boolean, log: (msg: string) => void): ((file: string, content: string, caption: string) => Promise<boolean>) | undefined {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!enabled || !token || !chatId) return undefined;
  return async (file, content, caption) => {
    try {
      const form = new FormData();
      form.set("chat_id", chatId);
      form.set("caption", caption);
      form.set("disable_notification", "true");
      form.set("document", new Blob([content], { type: "application/json" }), file);
      const sent = (await (await fetch(`${api()}/bot${token}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) })).json()) as { ok: boolean; result?: { message_id: number }; description?: string };
      if (!sent.ok || !sent.result) {
        log(`Aviso: Telegram no aceptó el informe: ${sent.description}`);
        return false;
      }
      const pin = (await (
        await fetch(`${api()}/bot${token}/pinChatMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, message_id: sent.result.message_id, disable_notification: true }),
          signal: AbortSignal.timeout(10_000),
        })
      ).json()) as { ok: boolean; description?: string };
      if (!pin.ok) log(`Aviso: no se pudo fijar el informe: ${pin.description}`);
      return true;
    } catch (err) {
      log(`Aviso: no se pudo enviar el informe a Telegram: ${(err as Error).message}`);
      return false;
    }
  };
}
