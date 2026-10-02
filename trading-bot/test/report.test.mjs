import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { telegramReporter } from "../dist/notify.js";
import { caption, logTail, markReported, remember, reportDue } from "../dist/report.js";

test("a report is due when never sent and again after the interval; 0 hours = only on demand", () => {
  const dir = mkdtempSync(join(tmpdir(), "informe-"));
  try {
    const now = Date.UTC(2026, 9, 1);
    assert.equal(reportDue(dir, 24, now), true);
    markReported(dir, now);
    assert.equal(reportDue(dir, 24, now + 23 * 3_600_000), false);
    assert.equal(reportDue(dir, 24, now + 24 * 3_600_000), true);
    assert.equal(reportDue(dir, 0, now + 99 * 3_600_000), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the log tail keeps only the latest lines and captions fit Telegram", () => {
  for (let i = 0; i < 450; i++) remember(`línea ${i}`);
  assert.equal(logTail.length, 400);
  assert.equal(logTail[0], "línea 50");
  assert.equal(caption("x".repeat(2000)).length, 1000);
  assert.equal(caption("corto"), "corto");
});

test("the report goes to the owner's chat as a file and is pinned silently", async () => {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      const method = req.url.split("/").pop();
      calls.push({ method, body });
      res.end(JSON.stringify(method === "sendDocument" ? { ok: true, result: { message_id: 77 } } : { ok: true, result: true }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const env = { ...process.env };
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "42", TELEGRAM_API_URL: `http://127.0.0.1:${server.address().port}` });
  try {
    const send = telegramReporter(true, () => {});
    assert.equal(await send("informe.json", '{"a":1}', "📊 Informe"), true);
    assert.deepEqual(calls.map((c) => c.method), ["sendDocument", "pinChatMessage"]);
    assert.match(calls[0].body, /filename="informe.json"/);
    assert.match(calls[0].body, /\{"a":1\}/);
    assert.deepEqual(JSON.parse(calls[1].body), { chat_id: "42", message_id: 77, disable_notification: true });
    assert.equal(telegramReporter(false, () => {}), undefined);
  } finally {
    process.env = env;
    server.close();
  }
});
