import { systemOne } from "./jev-client.js";

// Jeff's thresholds (SFMC Content Agent, lib/review/score.ts): pass at 80% or
// more, fail at 30% or less, unsure in between. Rows Jev judges can't be
// checked from the email content (naming, audience counts, seed tests...)
// are N/A rather than a guessed pass or fail.
export const PASS = 0.8;
export const FAIL = 0.3;
export const APPLICABLE = 0.5;
const QUESTIONS_PER_REQUEST = 50;
const PARALLEL_REQUESTS = 4;

const pct = (p) => `${Math.round(p * 100)}%`;

// Each sheet row becomes two yes/no questions. The check is phrased as a pass
// statement, because rows are worded both ways ("Is the subject line
// correct?" vs "Are there any grammatical errors?").
export function rowQuestions(category, text) {
  const check = category ? `${category}: ${text}` : text;
  return {
    pass: { type: "noul", instructions: `QA checklist item: "${check}". True if this email passes the check: the requirement is met and no problem it asks about is present.` },
    applicable: { type: "noul", instructions: `QA checklist item: "${check}". True if this item can be judged from the email's content alone (subject, preheader, copy, links, images, footer, personalization). False if it needs things outside the email, such as SFMC settings, audience data, counts, schedules, test sends or send reports.` },
  };
}

export function rowResult(passAnswer, applicableAnswer, model) {
  if (!passAnswer || !applicableAnswer) return { status: "Error", detail: "Jev returned no answer for this row." };
  const p = Math.min(1, Math.max(0, passAnswer.noul ?? 0));
  const a = Math.min(1, Math.max(0, applicableAnswer.noul ?? 0));
  const status = a < APPLICABLE ? "N/A" : p >= PASS ? "Pass" : p <= FAIL ? "Fail" : "Unsure";
  const why = status === "N/A"
    ? `Jev judged this can't be checked from the email content (applicable ${pct(a)}); a person needs to check it.`
    : `Pass probability ${pct(p)} (passes at ${pct(PASS)} or more, fails at ${pct(FAIL)} or less). Applicable ${pct(a)}.`;
  return { status, p, a, detail: `${why} Model ${model}.` };
}

async function inParallel(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// tables: from readQuestionTables. Returns { results: Map, counts, failed, model }.
export async function runJeff(config, state, tables) {
  const rows = tables.flatMap((t) => t.questions.map((q) => ({ key: `${t.title}\u0000${q.row}`, tab: t.title, ...q })));
  const perRequest = Math.floor(QUESTIONS_PER_REQUEST / 2);
  const chunks = [];
  for (let i = 0; i < rows.length; i += perRequest) chunks.push(rows.slice(i, i + perRequest));
  const answers = await inParallel(chunks, PARALLEL_REQUESTS, async (chunk) => {
    const questions = {};
    chunk.forEach((r, i) => {
      const q = rowQuestions(r.category, r.text);
      questions[`p${i}`] = q.pass;
      questions[`a${i}`] = q.applicable;
    });
    return { chunk, response: await systemOne(config, state, questions) };
  });
  const results = new Map();
  const counts = { Pass: 0, Fail: 0, Unsure: 0, "N/A": 0, Error: 0 };
  const failed = [];
  let model = config.model;
  for (const { chunk, response } of answers) {
    model = response.model || model;
    chunk.forEach((r, i) => {
      const result = rowResult(response.answers?.[`p${i}`], response.answers?.[`a${i}`], model);
      results.set(r.key, result);
      counts[result.status]++;
      if (result.status === "Fail" || result.status === "Unsure") failed.push({ ...r, ...result });
    });
  }
  return { results, counts, failed, model, total: rows.length };
}

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The Slack thread summary. Model output never appears here (Jev returns
// numbers), but sheet text does, so it's escaped too.
export function formatJeffSummary(outcome, { sheetUrl, notes = [] }) {
  const c = outcome.counts;
  const tally = `${c.Pass} pass · ${c.Fail} fail · ${c.Unsure} unsure · ${c["N/A"]} N/A${c.Error ? ` · ${c.Error} errors` : ""}`;
  const lines = outcome.failed
    .slice(0, 25)
    .map((f) => `${f.status === "Fail" ? ":x:" : ":warning:"} ${esc(f.category ? `${f.category}: ` : "")}${esc(f.text).slice(0, 200)} _(${Math.round(f.p * 100)}% pass)_`);
  if (outcome.failed.length > 25) lines.push(`…and ${outcome.failed.length - 25} more in the sheet.`);
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `*Jev checked ${outcome.total} QA sheet questions against the email*\n${tally}` } },
  ];
  if (lines.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: lines.join("\n").slice(0, 2900) } });
  const footer = [`Results are in the "Review Results by Jev" column of the <${sheetUrl}|QA sheet> (details in the hidden "Jev Results" column). Model ${esc(outcome.model)}. N/A rows need a person; Jev only sees the email.`, ...notes.map(esc)];
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer.join("\n").slice(0, 2900) }] });
  return { text: `Jev QA: ${tally}`, blocks };
}
