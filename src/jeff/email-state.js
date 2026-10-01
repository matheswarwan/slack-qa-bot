// Turns raw email HTML into the text-only snapshot Jev reads. Jeff never
// sends raw HTML to Jev: it reads literally and loses accuracy on markup and
// irrelevant detail. Adapted from SFMC Content Agent's lib/review/state.ts,
// which builds the same shape from the app's email blocks.
const MAX_SECTION_CHARS = 1500;
const MAX_SECTIONS = 40;
const MAX_LINKS = 40;
const MAX_IMAGES = 20;

export function stripHtml(html) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li|td)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&zwnj;|&#8204;|&#847;|‌|͏/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "").replace(/&amp;/g, "&") : null;
};

// SFMC emails hide the preheader in an element styled display:none (often
// with max-height:0 / mso-hide:all) near the top of the body.
function findPreheader(body) {
  const m = body.match(/<(div|span|td)\b[^>]*style\s*=\s*"[^"]*(display\s*:\s*none|mso-hide\s*:\s*all|max-height\s*:\s*0)[^"]*"[^>]*>([\s\S]*?)<\/\1>/i);
  return m ? stripHtml(m[3]).slice(0, 300) : "";
}

export function buildEmailState(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [null, html])[1];
  const preheader = findPreheader(body);
  const visible = body.replace(/<(div|span|td)\b[^>]*style\s*=\s*"[^"]*display\s*:\s*none[^"]*"[^>]*>[\s\S]*?<\/\1>/i, " ");

  const links = [];
  for (const m of visible.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= MAX_LINKS) break;
    const url = attr(m[1], "href");
    if (url === null) continue;
    const text = stripHtml(m[2]) || (m[2].match(/<img\b[^>]*>/i) ? `image: ${attr(m[2], "alt") || "no alt text"}` : "");
    links.push({ index: links.length, text: text.slice(0, 120), url: url.trim() });
  }

  const images = [];
  for (const m of visible.matchAll(/<img\b[^>]*>/gi)) {
    if (images.length >= MAX_IMAGES) break;
    const src = attr(m[0], "src") || "";
    if (/^data:|spacer|pixel|\/open\.aspx/i.test(src) || /^(1|0)$/.test(attr(m[0], "width") || "")) continue;
    images.push({ index: images.length, alt: attr(m[0], "alt") ?? "(no alt attribute)", url: src });
  }

  // Sections: the text of each table row / paragraph-level block, in order.
  const lines = stripHtml(visible).split("\n").map((t) => t.trim()).filter(Boolean);
  const sections = lines.slice(0, MAX_SECTIONS).map((text, index) => ({ index, text: text.slice(0, MAX_SECTION_CHARS) }));

  // The footer is the last part of the email that mentions unsubscribing,
  // preferences, privacy or an address. Found across all the text, so a long
  // email's footer isn't lost when sections are capped.
  const footerStart = lines.map((t) => /unsubscribe|preferences|privacy|opt.?out|all rights reserved|©|\b\d{5}(-\d{4})?\b/i.test(t)).lastIndexOf(true);
  const footerText = footerStart >= 0 ? lines.slice(Math.max(0, footerStart - 2)).join("\n") : "";

  const personalization = [...new Set(html.match(/%%[^%\s]+%%|%%=[\s\S]*?=%%/g) || [])].slice(0, 30);

  return {
    subject: stripHtml(title).slice(0, 300),
    preheader,
    sections,
    links,
    images,
    footerText: footerText.slice(0, 2000),
    personalization,
  };
}
