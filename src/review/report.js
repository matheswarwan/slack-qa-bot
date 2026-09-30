// Formats a review as a Slack thread reply.
const ICON = { fail: ":x:", warning: ":warning:", pass: ":white_check_mark:", not_checked: ":grey_question:" };
const SEVERITY_ICON = { high: ":red_circle:", medium: ":large_orange_circle:", low: ":white_circle:" };
const MAX_SECTION = 2900;
const MAX_BLOCKS = 45;

// Model output is untrusted: stop it from pinging (<!channel>), mentioning or
// disguising links.
export function escapeSlack(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function line(icon, text, where) {
  return `${icon} ${escapeSlack(text)}${where ? ` _(${escapeSlack(where)})_` : ""}`;
}

// Packs lines into section blocks under Slack's 3000-character limit.
function sections(lines) {
  const blocks = [];
  let current = "";
  for (const l of lines) {
    const piece = l.length > MAX_SECTION ? l.slice(0, MAX_SECTION - 1) + "…" : l;
    if (current && current.length + piece.length + 1 > MAX_SECTION) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: current } });
      current = "";
    }
    current += (current ? "\n" : "") + piece;
  }
  if (current) blocks.push({ type: "section", text: { type: "mrkdwn", text: current } });
  return blocks;
}

export function formatReview(review, { model, sources, notes, sheetUrl }) {
  const count = (r) => review.checks.filter((c) => c.result === r).length;
  const tally = `${count("fail")} failed · ${count("warning")} warnings · ${count("pass")} passed · ${count("not_checked")} not checked` +
    (review.other_issues.length ? ` · ${review.other_issues.length} other issues` : "");
  const lines = [];
  for (const result of ["fail", "warning"]) {
    for (const c of review.checks.filter((x) => x.result === result)) {
      lines.push(line(ICON[result], `*${c.item}*: ${c.finding}`, c.location));
    }
  }
  for (const i of review.other_issues) lines.push(line(SEVERITY_ICON[i.severity] || ":white_circle:", i.finding, i.location));
  const unchecked = review.checks.filter((c) => c.result === "not_checked").map((c) => escapeSlack(c.item));
  if (unchecked.length) lines.push(`${ICON.not_checked} Not checked: ${unchecked.join("; ")}`);

  let blocks = [
    { type: "section", text: { type: "mrkdwn", text: `*Claude's first-pass review*\n${escapeSlack(review.summary)}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: tally }] },
    ...sections(lines),
  ];
  const footer = [`Reviewed ${sources.map(escapeSlack).join(", ") || "no material"} with ${escapeSlack(model)}. The assignee makes the final call.`];
  if (sheetUrl) footer.push(`Full results are in the "Claude review" tab of the <${sheetUrl}|QA sheet>.`);
  if (notes.length) footer.push(...notes.map(escapeSlack));
  if (blocks.length > MAX_BLOCKS - 1) {
    blocks = blocks.slice(0, MAX_BLOCKS - 2);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_More findings than fit in one message; see the QA sheet._" } });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer.join("\n").slice(0, 2900) }] });
  return { text: `Claude's first-pass review: ${tally}`, blocks };
}
