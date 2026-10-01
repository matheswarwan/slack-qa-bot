// Finds the QA questions in the task's copied sheet and writes Jev's results
// next to them. Works with both template layouts: "Category | Check Item |
// Validation Instruction | Status | Evidence" and "Category | Detail |
// Completed" (where the category is only filled on a group's first row).
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
export const RESULT_HEADER = "Review Results by Jev";
export const DETAIL_HEADER = "Jev Results";
const QUESTION_HEADER = /^(check item|detail|question|check)$/i;
const INSTRUCTION_HEADER = /instruction/i;
const CATEGORY_HEADER = /^category$/i;

async function sheetsJson(accessToken, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Sheets API HTTP ${res.status}`);
  return data;
}

const quoted = (title) => `'${title.replace(/'/g, "''")}'`;

export function columnLetter(index) {
  let n = index + 1, s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Pure: finds the question table in one tab's values. Returns null if the tab
// has no question column (Overview, Execution Verification, metrics tabs...).
export function findQuestions(title, values) {
  const headerRow = values.slice(0, 5).findIndex((row) => (row || []).some((c) => QUESTION_HEADER.test(String(c).trim())));
  if (headerRow < 0) return null;
  const header = values[headerRow].map((c) => String(c).trim());
  const qCol = header.findIndex((c) => QUESTION_HEADER.test(c));
  const iCol = header.findIndex((c) => INSTRUCTION_HEADER.test(c));
  const cCol = header.findIndex((c) => CATEGORY_HEADER.test(c));
  // Re-runs reuse the columns added last time.
  const existing = header.indexOf(RESULT_HEADER);
  const lastCol = header.reduce((last, c, i) => (c ? i : last), 0);
  const resultCol = existing >= 0 ? existing : lastCol + 1;
  const questions = [];
  let category = "";
  for (let r = headerRow + 1; r < values.length; r++) {
    const row = values[r] || [];
    const cell = (i) => (i >= 0 ? String(row[i] ?? "").trim() : "");
    if (cell(cCol)) category = cell(cCol);
    const q = cell(qCol);
    if (!q) continue;
    const instruction = cell(iCol);
    questions.push({ row: r, category, text: instruction ? `${q}: ${instruction}` : q });
  }
  return questions.length ? { title, headerRow, resultCol, questions } : null;
}

export async function readQuestionTables(accessToken, spreadsheetId) {
  const meta = await sheetsJson(accessToken, `${SHEETS}/${spreadsheetId}?fields=sheets.properties(sheetId,title)`);
  const tabs = (meta.sheets || []).map((s) => s.properties);
  if (!tabs.length) return [];
  const ranges = tabs.map((t) => `ranges=${encodeURIComponent(quoted(t.title))}`).join("&");
  const data = await sheetsJson(accessToken, `${SHEETS}/${spreadsheetId}/values:batchGet?${ranges}`);
  return tabs
    .map((t, i) => {
      const table = findQuestions(t.title, data.valueRanges?.[i]?.values || []);
      return table && { ...table, sheetId: t.sheetId };
    })
    .filter(Boolean);
}

// results: Map of `${title}\u0000${row}` -> { status, detail }
export async function writeResults(accessToken, spreadsheetId, tables, results) {
  const data = [];
  for (const t of tables) {
    const rc = columnLetter(t.resultCol), dc = columnLetter(t.resultCol + 1);
    data.push({ range: `${quoted(t.title)}!${rc}${t.headerRow + 1}:${dc}${t.headerRow + 1}`, values: [[RESULT_HEADER, DETAIL_HEADER]] });
    for (const q of t.questions) {
      const r = results.get(`${t.title}\u0000${q.row}`);
      if (r) data.push({ range: `${quoted(t.title)}!${rc}${q.row + 1}:${dc}${q.row + 1}`, values: [[r.status, r.detail]] });
    }
  }
  await sheetsJson(accessToken, `${SHEETS}/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });
  // Hide the detail column.
  await sheetsJson(accessToken, `${SHEETS}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: tables.map((t) => ({
        updateDimensionProperties: {
          range: { sheetId: t.sheetId, dimension: "COLUMNS", startIndex: t.resultCol + 1, endIndex: t.resultCol + 2 },
          properties: { hiddenByUser: true },
          fields: "hiddenByUser",
        },
      })),
    }),
  });
}
