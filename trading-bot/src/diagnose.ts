// Connectivity check of every data source and broker, from wherever the bot runs. Binance answers
// 451 ("restricted location") to countries where it does not operate, such as the US.

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** What the bot loses when this check fails. */
  impact: string;
}

async function probe(url: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  } catch (err) {
    return { status: 0, body: (err as Error).message };
  }
}

function explain(status: number, body: string): string {
  if (status === 451 || /restricted location/i.test(body)) return "Binance bloquea este país (HTTP 451)";
  if (status === 403) return "acceso denegado (HTTP 403)";
  if (status === 0) return `sin conexión: ${body}`;
  return `HTTP ${status}`;
}

export async function diagnose(env: NodeJS.ProcessEnv = process.env): Promise<Check[]> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const targets: { name: string; url: string; impact: string; init?: RequestInit; ok?: (s: number) => boolean }[] = [
    { name: "Binance datos de mercado (spot)", url: "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=3m&limit=1", impact: "sin precios de cripto: el bot no puede operar cripto" },
    { name: "Binance API de órdenes (spot)", url: "https://api.binance.com/api/v3/ping", impact: "no se puede operar en Binance real ni en su testnet desde aquí (el modo simulado sí funciona)" },
    { name: "Binance futuros en vivo", url: "https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=1", impact: "los datos de futuros llegan solo del archivo diario (hasta ayer)" },
    { name: "Binance archivo histórico", url: `https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-${yesterday}.zip`, impact: "sin historia de futuros para estudios y aprendizaje" },
    { name: "Yahoo Finance (divisas)", url: "https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?range=1d&interval=1h", impact: "sin precios de divisas si forex.data es yahoo", init: { headers: { "User-Agent": "Mozilla/5.0" } } },
  ];
  if (env.TELEGRAM_BOT_TOKEN) targets.push({ name: "Telegram", url: `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`, impact: "sin avisos ni control por Telegram" });
  if (env.OANDA_API_KEY) {
    targets.push({
      name: "OANDA",
      url: `${env.OANDA_BASE_URL ?? "https://api-fxpractice.oanda.com"}/v3/accounts`,
      impact: "sin operar divisas en OANDA",
      init: { headers: { Authorization: `Bearer ${env.OANDA_API_KEY}` } },
    });
  }
  return Promise.all(
    targets.map(async (t) => {
      const r = await probe(t.url, t.init);
      const ok = r.status >= 200 && r.status < 300;
      return { name: t.name, ok, detail: ok ? "OK" : explain(r.status, r.body), impact: t.impact };
    }),
  );
}
