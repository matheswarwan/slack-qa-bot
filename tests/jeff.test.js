import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildEmailState } from "../src/jeff/email-state.js";
import { JevError, systemOne } from "../src/jeff/jev-client.js";
import { formatJeffSummary, rowQuestions, rowResult, runJeff } from "../src/jeff/run.js";
import { columnLetter, DETAIL_HEADER, findQuestions, RESULT_HEADER, writeResults } from "../src/jeff/sheet.js";
import { ReviewRunner } from "../src/review/runner.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init, calls.length); };
  return calls;
}

// Rows as they are in the reference templates (QA Docs template.zip).
const PRE_DEPLOYMENT = [
  ["Category", "Check Item", "Validation Instruction", "Status (Pass/Fail)", "Evidence / Screenshot Link"],
  ["DATA", "Audience Logic", "Paste the exact query used. Does it match the Brief?", "🚧 REVIEW", "[Paste Screenshot of Query]"],
  ["CREATIVE", "Subject Line", "Matches Brief exactly? Check spelling/grammar.", "🚧 REVIEW", "[Type here]"],
  ["CREATIVE", "Compliance Check", "GDPR/CAN-SPAM: Unsubscribe link present and working?", "🚧 REVIEW"],
];
const BETA = [
  ["Category", "Detail", "Completed"],
  ["Naming Convention", "Does the email name follow the customer's naming convention?"],
  ["Subject Line", "Is the subject line correct?"],
  ["", "Is everything spelled correctly?"],
  ["", "Are there any grammatical errors?"],
];

test("findQuestions: both template layouts; skips tabs without questions", () => {
  const a = findQuestions("Pre-Deployment Validation", PRE_DEPLOYMENT);
  assert.equal(a.headerRow, 0);
  assert.equal(a.resultCol, 5, "after Evidence (E) → F");
  assert.deepEqual(a.questions[1], { row: 2, category: "CREATIVE", text: "Subject Line: Matches Brief exactly? Check spelling/grammar." });
  const b = findQuestions("QA-Email Send", BETA);
  assert.equal(b.resultCol, 3);
  assert.deepEqual(b.questions.map((q) => q.category), ["Naming Convention", "Subject Line", "Subject Line", "Subject Line"], "category carries down");
  assert.equal(findQuestions("Overview & Status", [["Customer Name / Account", "[Enter Customer Name]"]]), null);
  // A re-run reuses the columns it added.
  const rerun = findQuestions("QA-Email Send", [["Category", "Detail", "Completed", RESULT_HEADER, DETAIL_HEADER], ...BETA.slice(1)]);
  assert.equal(rerun.resultCol, 3);
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(27), "AB");
});

const EMAIL = `<!doctype html><html><head><title>Your %%FirstName%%, spring is here</title><style>.x{}</style></head>
<body><div style="display:none;max-height:0;overflow:hidden">Save 20% this week only&zwnj;&nbsp;</div>
<table><tr><td><img src="https://img.example/logo.png" alt="Acme"></td></tr>
<tr><td><h1>Spring sale</h1><p>Hi %%FirstName%%, everything is 20% off.</p></td></tr>
<tr><td><a href="https://acme.example/sale?utm_source=sfmc">Shop now</a> <a href="https://acme.example/x"><img src="https://img.example/hero.png"></a></td></tr>
<tr><td><img src="https://cl.exct.net/open.aspx?x=1" width="1"></td></tr>
<tr><td>Acme Inc, 1 Main St, Springfield 12345. <a href="%%unsub_center_url%%">Unsubscribe</a></td></tr></table></body></html>`;

test("buildEmailState: subject from <title>, hidden preheader, links, images, footer, tokens", () => {
  const s = buildEmailState(EMAIL);
  assert.equal(s.subject, "Your %%FirstName%%, spring is here");
  assert.equal(s.preheader, "Save 20% this week only");
  assert.ok(!s.sections.some((x) => x.text.includes("Save 20%")), "the preheader isn't counted as body copy");
  assert.deepEqual(s.links.map((l) => l.text), ["Shop now", "image: no alt text", "Unsubscribe"]);
  assert.equal(s.links[2].url, "%%unsub_center_url%%");
  assert.deepEqual(s.images.map((i) => i.alt), ["Acme", "(no alt attribute)"], "tracking pixel skipped");
  assert.match(s.footerText, /Unsubscribe/);
  assert.deepEqual(s.personalization, ["%%FirstName%%", "%%unsub_center_url%%"]);
  assert.equal(buildEmailState("<p>No head</p>").subject, "");
});

test("rowQuestions / rowResult: pass statement, thresholds, N/A when not judgeable", () => {
  const q = rowQuestions("Subject Line", "Are there any grammatical errors?");
  assert.equal(q.pass.type, "noul");
  assert.match(q.pass.instructions, /passes the check/);
  assert.equal(rowResult({ noul: 0.85 }, { noul: 0.9 }, "jev-1.13.0").status, "Pass");
  assert.equal(rowResult({ noul: 0.2 }, { noul: 0.9 }, "m").status, "Fail");
  assert.equal(rowResult({ noul: 0.5 }, { noul: 0.9 }, "m").status, "Unsure");
  const na = rowResult({ noul: 0.9 }, { noul: 0.1 }, "m");
  assert.equal(na.status, "N/A");
  assert.match(na.detail, /a person needs to check it/);
  assert.match(rowResult({ noul: 0.85 }, { noul: 0.9 }, "jev-1.13.0").detail, /Pass probability 85%.*Applicable 90%.*Model jev-1\.13\.0/);
  assert.equal(rowResult(undefined, { noul: 1 }, "m").status, "Error");
});

test("jev-client: posts state and questions, retries 429, explains 401", async () => {
  let n = 0;
  const calls = stubFetch((url, init) => {
    n++;
    if (n === 1) return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
    return Response.json({ model: "jev-1.13.0", answers: { p0: { type: "noul", noul: 0.9 } } });
  });
  const res = await systemOne({ apiKey: "k", model: "jev-1.13.0", baseUrl: "https://mock.jev/" }, { subject: "x" }, { p0: { type: "noul", instructions: "q" } });
  assert.equal(res.answers.p0.noul, 0.9);
  assert.equal(calls[1].url, "https://mock.jev/v1/systemone");
  assert.equal(calls[1].init.headers.Authorization, "Bearer k");
  assert.deepEqual(JSON.parse(calls[1].init.body), { model: "jev-1.13.0", state: { subject: "x" }, questions: { p0: { type: "noul", instructions: "q" } } });
  stubFetch(() => new Response("no", { status: 401 }));
  await assert.rejects(systemOne({ apiKey: "bad", model: "m" }, {}, {}), (e) => e instanceof JevError && /API key was rejected/.test(e.message));
});

test("runJeff: 25 rows (50 Jev questions) per request, answers mapped back to rows", async () => {
  const many = [["Category", "Detail"], ...Array.from({ length: 60 }, (_, i) => ["Copy", `Question ${i}`])];
  const table = findQuestions("QA", many);
  const sizes = [];
  stubFetch((url, init) => {
    const { questions } = JSON.parse(init.body);
    sizes.push(Object.keys(questions).length);
    const answers = {};
    for (const [k, q] of Object.entries(questions)) {
      const i = Number(q.instructions.match(/Question (\d+)/)[1]);
      answers[k] = { type: "noul", noul: k.startsWith("a") ? (i === 7 ? 0.1 : 0.95) : i % 3 === 0 ? 0.1 : 0.9 };
    }
    return Response.json({ model: "jev-1.13.0", answers });
  });
  const out = await runJeff({ apiKey: "k", model: "jev-1.13.0", baseUrl: "https://mock.jev" }, { subject: "s" }, [table]);
  assert.deepEqual(sizes.sort((a, b) => b - a), [50, 50, 20]);
  assert.equal(out.total, 60);
  assert.equal(out.results.get("QA\u00001").status, "Fail", "Question 0 → row 1");
  assert.equal(out.results.get("QA\u00002").status, "Pass");
  assert.equal(out.results.get("QA\u00008").status, "N/A", "Question 7 is not judgeable");
  assert.equal(out.counts.Fail + out.counts.Pass + out.counts["N/A"], 60);
  const summary = formatJeffSummary(out, { sheetUrl: "https://docs.google.com/spreadsheets/d/S" });
  assert.match(summary.text, /Jev QA: 40 pass · 20 fail · 0 unsure · 0 N\/A|Jev QA: \d+ pass/);
  assert.ok(JSON.stringify(summary.blocks).includes("Review Results by Jev"));
});

test("writeResults: header + one cell pair per row, then hides the detail column", async () => {
  const table = { ...findQuestions("QA-Email Send", BETA), sheetId: 42 };
  const calls = stubFetch(() => Response.json({}));
  const results = new Map([["QA-Email Send\u00002", { status: "Pass", detail: "Pass probability 90%." }]]);
  await writeResults("tok", "S1", [table], results);
  const values = JSON.parse(calls[0].init.body);
  assert.equal(values.valueInputOption, "RAW");
  assert.deepEqual(values.data[0], { range: "'QA-Email Send'!D1:E1", values: [[RESULT_HEADER, DETAIL_HEADER]] });
  assert.deepEqual(values.data[1], { range: "'QA-Email Send'!D3:E3", values: [["Pass", "Pass probability 90%."]] });
  const hide = JSON.parse(calls[1].init.body).requests[0].updateDimensionProperties;
  assert.deepEqual(hide.range, { sheetId: 42, dimension: "COLUMNS", startIndex: 4, endIndex: 5 });
  assert.equal(hide.properties.hiddenByUser, true);
});

class MemoryStorage {
  data = new Map(); alarm = null;
  async get(k) { return structuredClone(this.data.get(k)); }
  async put(k, v) { this.data.set(k, structuredClone(v)); }
  async setAlarm(t) { this.alarm = t; }
}

test("runner (jeff): waits for the sheet, then checks its questions and writes the results", async () => {
  const storage = new MemoryStorage();
  const posts = [], written = [];
  const tables = [{ ...findQuestions("QA-Email Send", BETA), sheetId: 1 }];
  const r = new ReviewRunner({ storage }, {}, {
    googleToken: async () => "gtok",
    collectMaterials: async () => ({ materials: [{ source: "spring.html", kind: "html", content: EMAIL }], notes: [] }),
    readQuestionTables: async (tok, id) => { assert.equal(id, "S7"); return tables; },
    runJeff: async (state, t) => {
      assert.equal(state.subject, "Your %%FirstName%%, spring is here");
      return { results: new Map(), counts: { Pass: 2, Fail: 1, Unsure: 0, "N/A": 1, Error: 0 }, failed: [{ category: "Subject Line", text: "Is everything spelled correctly?", status: "Fail", p: 0.1 }], model: "jev-1.13.0", total: 4 };
    },
    writeJevResults: async (...args) => written.push(args),
    postToThread: async (job, m) => posts.push(m),
  });
  const call = (path, body) => r.fetch(new Request(`https://review${path}`, { method: "POST", body: JSON.stringify(body) }));
  await call("/start", { job: { kind: "jeff", taskId: "t", channelId: "C", threadTs: "1.1", qaType: "Email Send", inputs: { url: "https://x" } } });
  assert.equal(storage.alarm, null, "Jeff doesn't start before the sheet exists");
  await r.alarm();
  assert.equal(posts.length, 0);
  await call("/sheet", { spreadsheetId: "S7" });
  assert.ok(storage.alarm);
  await r.alarm();
  assert.equal(written.length, 1);
  assert.equal(written[0][1], "S7");
  assert.match(posts[0].text, /Jev is checking/);
  assert.match(posts[1].text, /Jev QA: 2 pass · 1 fail · 0 unsure · 1 N\/A/);
  assert.equal((await storage.get("job")).status, "done");
});
