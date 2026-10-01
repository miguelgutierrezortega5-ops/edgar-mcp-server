export type Notifier = (text: string) => Promise<void>;

/** Telegram notifications when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set; otherwise a no-op. */
export function telegramNotifier(enabled: boolean, log: (msg: string) => void): Notifier {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!enabled || !token || !chatId) return async () => {};
  return async (text) => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=${offset}`, { signal: AbortSignal.timeout(10_000) });
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
