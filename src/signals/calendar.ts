/** Economic calendar with consensus forecasts (Forex Factory's public weekly JSON feed). */
import { HttpError, httpGet } from "../services/http.js";

export interface CalendarEvent {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast: string;
  previous: string;
}

async function week(path: string): Promise<CalendarEvent[]> {
  try {
    return await httpGet<CalendarEvent[]>("forexfactory", path, { ttl: 30 * 60 * 1000 });
  } catch (e) {
    // Next week's file is published late in the current week; until then it is a 404.
    if (e instanceof HttpError && e.status === 404) return [];
    throw e;
  }
}

export async function getCalendar(includeNextWeek: boolean): Promise<CalendarEvent[]> {
  const [thisWeek, nextWeek] = await Promise.all([week("/ff_calendar_thisweek.json"), includeNextWeek ? week("/ff_calendar_nextweek.json") : Promise.resolve([])]);
  return [...thisWeek, ...nextWeek].sort((a, b) => a.date.localeCompare(b.date));
}

export function filterCalendar(events: CalendarEvent[], opts: { countries: string[]; impacts: string[]; from?: string; to?: string; query?: string }): CalendarEvent[] {
  const countries = new Set(opts.countries.map((c) => c.toUpperCase()));
  const impacts = new Set(opts.impacts.map((i) => i.toLowerCase()));
  const q = opts.query?.toLowerCase();
  return events.filter(
    (e) =>
      (!countries.size || countries.has(e.country.toUpperCase())) &&
      (!impacts.size || impacts.has(e.impact.toLowerCase())) &&
      (!opts.from || new Date(e.date).toISOString().slice(0, 10) >= opts.from) &&
      (!opts.to || new Date(e.date).toISOString().slice(0, 10) <= opts.to) &&
      (!q || e.title.toLowerCase().includes(q)),
  );
}
