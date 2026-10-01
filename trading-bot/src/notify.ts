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
