// Reads a QA type's checklist from its Google Sheet template, and writes
// Claude's review into a tab of the task's copied sheet.
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
export const REVIEW_TAB = "Claude review";
const MAX_CHECKLIST_CHARS = 60000;

async function sheetsJson(accessToken, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Sheets API HTTP ${res.status}`);
  return data;
}

// Every tab of the template, one line per non-empty row, under its tab name.
// (The Email Send template starts with an "Overview & Status" tab, so the
// first tab alone isn't the checklist.)
export async function readChecklist(accessToken, templateId) {
  const meta = await sheetsJson(accessToken, `${SHEETS}/${templateId}?fields=sheets.properties.title`);
  const titles = (meta.sheets || []).map((s) => s.properties.title);
  if (!titles.length) return "";
  const ranges = titles.map((t) => `ranges=${encodeURIComponent(`'${t.replace(/'/g, "''")}'`)}`).join("&");
  const data = await sheetsJson(accessToken, `${SHEETS}/${templateId}/values:batchGet?${ranges}`);
  const parts = titles.map((title, i) => {
    const lines = (data.valueRanges?.[i]?.values || [])
      .map((row) => row.map((cell) => String(cell).trim()).filter(Boolean).join(" | "))
      .filter(Boolean);
    return lines.length ? `## ${title}\n${lines.join("\n")}` : "";
  }).filter(Boolean);
  const text = parts.join("\n\n");
  return text.length > MAX_CHECKLIST_CHARS ? text.slice(0, MAX_CHECKLIST_CHARS) + "\n(checklist continues; truncated)" : text;
}

export function reviewRows(review, meta) {
  const rows = [
    ["First-pass review by Claude. The assignee makes the final call."],
    [`Model: ${meta.model}`, `Reviewed: ${meta.reviewedAt}`, `Material: ${meta.sources.join(", ") || "none"}`],
    ["Summary", review.summary],
    [],
    ["Checklist item", "Result", "Finding", "Where"],
    ...review.checks.map((c) => [c.item, c.result, c.finding, c.location]),
  ];
  if (review.other_issues.length) {
    rows.push([], ["Other issues", "Severity", "Finding", "Where"]);
    for (const i of review.other_issues) rows.push(["", i.severity, i.finding, i.location]);
  }
  return rows;
}

// Adds the tab (or reuses it on a retry) and writes the rows.
export async function writeReviewTab(accessToken, spreadsheetId, rows) {
  try {
    await sheetsJson(accessToken, `${SHEETS}/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: REVIEW_TAB } } }] }),
    });
  } catch (err) {
    if (!/already exists/i.test(err.message)) throw err;
  }
  const range = encodeURIComponent(`'${REVIEW_TAB}'!A1`);
  await sheetsJson(accessToken, `${SHEETS}/${spreadsheetId}/values/${range}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: rows }),
  });
}
