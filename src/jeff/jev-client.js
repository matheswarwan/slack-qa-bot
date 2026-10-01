// TypeSafe Jev (System One) over HTTP: POST {baseUrl}/v1/systemone with state +
// typed questions. Ported from SFMC Content Agent's lib/review/jev-client.ts.
// Retries 429 (rate limit) and 529 (overloaded) with backoff.
export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_DEFAULT_MODEL = "jev-1.13.0";
const TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function jevConfig(env) {
  return { apiKey: env.JEV_API_KEY, model: env.JEV_MODEL || JEV_DEFAULT_MODEL, baseUrl: env.JEV_BASE_URL || null };
}

// questions: { key: { type: "noul", instructions } | { type: "choice", ... } | { type: "score", ... } }
export async function systemOne(config, state, questions) {
  const url = `${(config.baseUrl || JEV_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1/systemone`;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.model, state, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) continue;
      throw new JevError(`Could not reach Jev: ${err.message}`);
    }
    if ((res.status === 429 || res.status === 529) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const reason = res.status === 401 ? "the API key was rejected"
        : res.status === 422 ? `the request was invalid (${body.slice(0, 300)})`
        : `HTTP ${res.status} ${body.slice(0, 200)}`;
      throw new JevError(`Jev failed: ${reason}`, res.status);
    }
    return res.json();
  }
}
