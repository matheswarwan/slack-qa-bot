// Gathers what the requester gave the bot to review: pasted text, a preview
// URL and uploaded files. Anything too large or unreadable is skipped with a
// note that is shown in Slack, rather than being cut short silently.
export const MAX_ITEM_CHARS = 400000;
export const MAX_TOTAL_CHARS = 600000;
const FETCH_TIMEOUT_MS = 20000;
const TEXT_TYPES = /^(text\/|application\/(xhtml\+xml|xml|json|markdown))/i;

export function guessKind(name, content) {
  if (/\.md$|\.markdown$/i.test(name || "")) return "markdown";
  if (/\.html?$/i.test(name || "") || /<\s*(html|body|table|div|td|a|img|!doctype)\b/i.test(content)) return "html";
  return "text";
}

async function fetchPreview(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { note: `Skipped the URL: it isn't a valid address.` };
  }
  if (parsed.protocol !== "https:") return { note: `Skipped ${url}: only https links are fetched.` };
  let res;
  try {
    res = await fetch(parsed.href, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { note: `Couldn't load ${url}: ${err.message}.` };
  }
  if (!res.ok) return { note: `Couldn't load ${url}: HTTP ${res.status}.` };
  const type = res.headers.get("content-type") || "";
  if (type && !TEXT_TYPES.test(type)) return { note: `Skipped ${url}: it returned ${type.split(";")[0]}, not a web page.` };
  const content = await res.text();
  if (content.length > MAX_ITEM_CHARS) return { note: `Skipped ${url}: the page is too large to review (${content.length.toLocaleString("en-US")} characters).` };
  return { item: { source: url, kind: guessKind(parsed.pathname, content), content } };
}

async function fetchSlackFile(env, fileId) {
  const infoRes = await fetch(`https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const info = await infoRes.json();
  if (!info.ok) return { note: `Couldn't read an uploaded file (${info.error}; the bot needs the files:read scope).` };
  const file = info.file;
  const name = file.name || fileId;
  if (file.size > MAX_ITEM_CHARS) return { note: `Skipped ${name}: too large to review (${file.size.toLocaleString("en-US")} bytes).` };
  const res = await fetch(file.url_private_download || file.url_private, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  if (!res.ok) return { note: `Couldn't download ${name}: HTTP ${res.status}.` };
  const content = await res.text();
  return { item: { source: name, kind: guessKind(name, content), content } };
}

// inputs: { text, url, fileIds }. Returns { materials, notes }.
export async function collectMaterials(env, inputs) {
  const results = [];
  if (inputs.text && inputs.text.trim()) {
    results.push({ item: { source: "pasted text", kind: guessKind("", inputs.text), content: inputs.text } });
  }
  if (inputs.url) results.push(await fetchPreview(inputs.url));
  for (const id of inputs.fileIds || []) results.push(await fetchSlackFile(env, id));

  const materials = [];
  const notes = [];
  let total = 0;
  for (const r of results) {
    if (r.note) notes.push(r.note);
    if (!r.item) continue;
    if (total + r.item.content.length > MAX_TOTAL_CHARS) {
      notes.push(`Skipped ${r.item.source}: together with the other material it's more than can be reviewed in one go.`);
      continue;
    }
    total += r.item.content.length;
    materials.push(r.item);
  }
  return { materials, notes };
}
