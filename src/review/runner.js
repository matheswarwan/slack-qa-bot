import { getGoogleAccessToken } from "../google-auth.js";
import { buildReviewRequest, requestReview, ReviewRefusedError } from "./claude.js";
import { collectMaterials } from "./inputs.js";
import { formatReview } from "./report.js";
import { readChecklist, reviewRows, writeReviewTab } from "./sheets.js";

// One ReviewRunner Durable Object per QA task. A review can take minutes,
// far longer than Slack waits for a reply, so it runs in the object's alarm
// (which may run for up to 15 minutes) instead of in the request.
//
//   POST /start  { job }            queue the review (ignored if already queued)
//   POST /sheet  { spreadsheetId }  the task's sheet exists: write the review tab
export class ReviewRunner {
  constructor(state, env, deps = {}) {
    this.state = state;
    this.env = env;
    this.deps = {
      googleToken: () => getGoogleAccessToken(env),
      collectMaterials: (inputs) => collectMaterials(env, inputs),
      readChecklist,
      writeReviewTab,
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
        await this.state.storage.setAlarm(Date.now());
      }
      return Response.json({ ok: true });
    }
    if (path === "/sheet") {
      await this.state.storage.put("sheetId", body.spreadsheetId);
      const job = await this.state.storage.get("job");
      if (await this.writeTabIfReady()) {
        await this.deps.postToThread(job, { text: `Claude's review is in the "Claude review" tab of the <${sheetUrl(body.spreadsheetId)}|QA sheet>.` });
      }
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    const job = await this.state.storage.get("job");
    if (!job || job.status !== "queued") return;
    job.status = "running";
    await this.state.storage.put("job", job);
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
