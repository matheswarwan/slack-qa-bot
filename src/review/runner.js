import { getGoogleAccessToken } from "../google-auth.js";
import { buildReviewRequest, requestReview, ReviewRefusedError } from "./claude.js";
import { collectMaterials } from "./inputs.js";
import { formatReview } from "./report.js";
import { readChecklist, reviewRows, writeReviewTab } from "./sheets.js";
import { buildEmailState } from "../jeff/email-state.js";
import { jevConfig } from "../jeff/jev-client.js";
import { formatJeffSummary, runJeff } from "../jeff/run.js";
import { readQuestionTables, writeResults } from "../jeff/sheet.js";

// One ReviewRunner Durable Object per QA task. Reviews can take longer than
// Slack waits for a reply, so they run in the object's alarm (which may run
// for up to 15 minutes) instead of in the request. Two kinds:
//   - "claude": journeys and automations. Starts as soon as the task is
//     created; the results tab is written once the sheet exists.
//   - "jeff": emails. Needs the task's sheet, because the questions come from
//     it, so it starts when the assignee accepts and the sheet is created.
//
//   POST /start  { job }            queue the review (ignored if already queued)
//   POST /sheet  { spreadsheetId }  the task's sheet exists
export class ReviewRunner {
  constructor(state, env, deps = {}) {
    this.state = state;
    this.env = env;
    this.deps = {
      googleToken: () => getGoogleAccessToken(env),
      collectMaterials: (inputs) => collectMaterials(env, inputs),
      readChecklist,
      writeReviewTab,
      readQuestionTables,
      writeJevResults: writeResults,
      runJeff: (state, tables) => runJeff(jevConfig(env), state, tables),
      requestReview: (request) => requestReview(env, request),
      postToThread: (job, message) => postToThread(env, job, message),
      now: () => new Date(),
      ...deps,
    };
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json();
    if (path === "/start") {
      if (!(await this.state.storage.get("job"))) {
        await this.state.storage.put("job", { ...body.job, status: "queued" });
        if (body.job.kind !== "jeff") await this.state.storage.setAlarm(Date.now());
      }
      return Response.json({ ok: true });
    }
    if (path === "/sheet") {
      await this.state.storage.put("sheetId", body.spreadsheetId);
      const job = await this.state.storage.get("job");
      if (job?.kind === "jeff") {
        if (job.status === "queued") await this.state.storage.setAlarm(Date.now());
      } else if (await this.writeTabIfReady()) {
        await this.deps.postToThread(job, { text: `Claude's review is in the "Claude review" tab of the <${sheetUrl(body.spreadsheetId)}|QA sheet>.` });
      }
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    const job = await this.state.storage.get("job");
    if (!job || job.status !== "queued") return;
    // Jeff's questions come from the task's sheet; wait for /sheet.
    if (job.kind === "jeff" && !(await this.state.storage.get("sheetId"))) return;
    job.status = "running";
    await this.state.storage.put("job", job);
    if (job.kind === "jeff") return this.runJeffJob(job);
    try {
      await this.deps.postToThread(job, { text: ":mag: Claude is doing a first-pass review…" });
      const notes = [];
      let accessToken = null;
      let checklist = "";
      try {
        accessToken = await this.deps.googleToken();
        checklist = await this.deps.readChecklist(accessToken, job.templateId);
      } catch (err) {
        notes.push(`Couldn't read the ${job.qaType} checklist template (${err.message}), so the review uses general QA practice.`);
      }
      const collected = await this.deps.collectMaterials(job.inputs);
      notes.push(...collected.notes);
      if (!collected.materials.length) {
        await this.deps.postToThread(job, { text: `Claude couldn't review this task: there was nothing it could read.${notes.length ? "\n" + notes.join("\n") : ""}` });
        job.status = "nothing_to_review";
        return;
      }
      const request = buildReviewRequest({
        qaType: job.qaType,
        project: job.project,
        notes: job.notes,
        checklist,
        materials: collected.materials,
        model: this.env.CLAUDE_MODEL,
      });
      const { review, model } = await this.deps.requestReview(request);
      const result = { review, model, reviewedAt: this.deps.now().toISOString(), sources: collected.materials.map((m) => m.source), notes };
      await this.state.storage.put("result", result);
      const sheetId = await this.state.storage.get("sheetId");
      await this.deps.postToThread(job, formatReview(review, { ...result, sheetUrl: sheetId ? sheetUrl(sheetId) : null }));
      await this.writeTabIfReady(accessToken);
      job.status = "done";
    } catch (err) {
      console.error("Review failed:", err);
      job.status = "failed";
      const why = err instanceof ReviewRefusedError ? err.message : `something went wrong (${err.message}).`;
      await this.deps.postToThread(job, { text: `:warning: Claude's review didn't finish: ${why} The task itself is unaffected.` }).catch(() => {});
    } finally {
      await this.state.storage.put("job", job);
    }
  }

  async runJeffJob(job) {
    try {
      await this.deps.postToThread(job, { text: ":mag: Jev is checking the QA sheet's questions against the email…" });
      const sheetId = await this.state.storage.get("sheetId");
      const collected = await this.deps.collectMaterials(job.inputs);
      const email = collected.materials.find((m) => m.kind === "html") || collected.materials[0];
      if (!email) {
        job.status = "nothing_to_review";
        await this.deps.postToThread(job, { text: `Jev couldn't check this email: there was no HTML it could read.${collected.notes.length ? "\n" + collected.notes.join("\n") : ""}` });
        return;
      }
      const notes = [...collected.notes];
      if (collected.materials.length > 1) notes.push(`Checked ${email.source}; Jev reviews one email per task.`);
      const accessToken = await this.deps.googleToken();
      const tables = await this.deps.readQuestionTables(accessToken, sheetId);
      if (!tables.length) {
        job.status = "nothing_to_review";
        await this.deps.postToThread(job, { text: "Jev found no question rows in the QA sheet (looked for a Check Item, Detail or Question column)." });
        return;
      }
      const state = buildEmailState(email.content);
      if (!state.subject) notes.push("The HTML has no <title>, so Jev had no subject line to check.");
      const outcome = await this.deps.runJeff(state, tables);
      await this.deps.writeJevResults(accessToken, sheetId, tables, outcome.results);
      await this.state.storage.put("jeff", { counts: outcome.counts, model: outcome.model, total: outcome.total });
      await this.deps.postToThread(job, formatJeffSummary(outcome, { sheetUrl: sheetUrl(sheetId), notes }));
      job.status = "done";
    } catch (err) {
      console.error("Jeff failed:", err);
      job.status = "failed";
      await this.deps.postToThread(job, { text: `:warning: Jev's check didn't finish: ${err.message} The task itself is unaffected.` }).catch(() => {});
    } finally {
      await this.state.storage.put("job", job);
    }
  }

  // Writes the review tab once both the review and the sheet exist. Returns
  // true if it wrote the tab this time.
  async writeTabIfReady(accessToken = null) {
    const [result, sheetId, written] = await Promise.all([
      this.state.storage.get("result"),
      this.state.storage.get("sheetId"),
      this.state.storage.get("tabWritten"),
    ]);
    if (!result || !sheetId || written) return false;
    try {
      await this.deps.writeReviewTab(accessToken || (await this.deps.googleToken()), sheetId, reviewRows(result.review, result));
      await this.state.storage.put("tabWritten", true);
      return true;
    } catch (err) {
      console.error("Couldn't write the review tab:", err);
      return false;
    }
  }
}

function sheetUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

async function postToThread(env, job, message) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: job.channelId, thread_ts: job.threadTs, unfurl_links: false, ...message }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack chat.postMessage: ${data.error}`);
}
