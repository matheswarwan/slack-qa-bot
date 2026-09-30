// Google service-account auth: signs a JWT with the private key and swaps it
// for an access token (Drive and Sheets scopes).
var GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
var GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive"
].join(" ");
function base64url(bytes) {
  let str = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i]);
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function strToBase64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
async function importPrivateKey(pem) {
  const pemBody = pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\\n/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}
export async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1e3);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: env.GOOGLE_SA_CLIENT_EMAIL,
    scope: GOOGLE_SCOPES,
    aud: GOOGLE_TOKEN_URI,
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${strToBase64url(JSON.stringify(header))}.${strToBase64url(JSON.stringify(claims))}`;
  const key = await importPrivateKey(env.GOOGLE_SA_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64url(signature)}`;
  const res = await fetch(GOOGLE_TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Error minting Google access token:", data);
    throw new Error(data.error_description || data.error || "Token exchange failed");
  }
  return data.access_token;
}
