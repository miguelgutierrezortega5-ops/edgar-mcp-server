/**
 * Banco de México SIE API (FIX exchange rate, target rate and any other SIE series). Needs a free
 * token in BANXICO_TOKEN: https://www.banxico.org.mx/SieAPIRest/service/v1/token
 */
import { httpGet } from "../services/http.js";

export const BANXICO_DEFAULTS: Record<string, string> = {
  SF43718: "Tipo de cambio FIX (pesos por dólar)",
  SF61745: "Tasa objetivo de Banxico (%)",
};

export interface BanxicoSeries {
  id: string;
  title: string;
  points: { date: string; value: number | null }[];
}

const toIso = (d: string) => {
  const [dd, mm, yyyy] = d.split("/");
  return `${yyyy}-${mm}-${dd}`;
};

export async function getBanxicoSeries(ids: string[], start?: string, end?: string): Promise<BanxicoSeries[]> {
  const token = process.env.BANXICO_TOKEN?.trim();
  if (!token) throw new Error("BANXICO_TOKEN is not set. Request a free token at https://www.banxico.org.mx/SieAPIRest/service/v1/token and add it to the server's environment.");
  const span = start ? `${start}/${end ?? new Date().toISOString().slice(0, 10)}` : "oportuno";
  const res = await httpGet<{ bmx: { series: { idSerie: string; titulo: string; datos?: { fecha: string; dato: string }[] }[] } }>(
    "banxico",
    `/SieAPIRest/service/v1/series/${ids.map(encodeURIComponent).join(",")}/datos/${span}`,
    { ttl: 30 * 60 * 1000, headers: { "Bmx-Token": token } },
  );
  return res.bmx.series.map((s) => ({
    id: s.idSerie,
    title: s.titulo,
    points: (s.datos ?? []).map((d) => ({ date: toIso(d.fecha), value: d.dato === "N/E" ? null : Number(d.dato.replace(/,/g, "")) })),
  }));
}
