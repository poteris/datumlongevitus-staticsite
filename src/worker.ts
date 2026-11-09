/// <reference types="@cloudflare/workers-types" />

interface Env {
  ASSETS: Fetcher;
  SIGNUPS: KVNamespace;
  EMAIL: SendEmail;
  SUBSCRIBE_LIMITER: RateLimit;
  TOKEN_SECRET: string;
  TURNSTILE_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  SITE_URL: string;
  FROM_ADDRESS: string;
  FROM_NAME: string;
  NOTIFY_ADDRESS: string;
  SIGNUP_ENABLED: string;
  CONSENT_VERSION: string;
  PDF_PATH: string;
  LINK_TTL_DAYS: string;
}

interface Signup {
  email: string;
  consentVersion: string;
  createdAt: string;
  lastSentAt: string;
  confirmedAt?: string;
}

const RESEND_COOLDOWN_MS = 10 * 60 * 1000;
// WHATWG HTML "valid email address" pattern, the same check browsers apply to <input type="email">.
// https://html.spec.whatwg.org/multipage/input.html#valid-e-mail-address
const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/subscribe") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      return subscribe(request, env);
    }
    if (url.pathname === "/api/confirm") return confirm(url, env);
    // The PDF is only reachable through a valid confirmation link.
    if (url.pathname.startsWith("/downloads/")) return new Response("Not found", { status: 404 });
    if (url.pathname === "/" || url.pathname === "/index.html") return withSiteKey(request, env);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// Inject the Turnstile site key from env into the page, so it isn't hard-coded in index.html.
async function withSiteKey(request: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  if (!res.headers.get("content-type")?.includes("text/html")) return res;
  const out = new HTMLRewriter()
    .on(".cf-turnstile", {
      element(el) {
        el.setAttribute("data-sitekey", env.TURNSTILE_SITE_KEY ?? "");
      },
    })
    .transform(res);
  // The asset's ETag doesn't change when only the env var does, so don't let caches revalidate on it.
  const headers = new Headers(out.headers);
  headers.delete("etag");
  headers.set("cache-control", "no-cache");
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
}

async function subscribe(request: Request, env: Env): Promise<Response> {
  if (env.SIGNUP_ENABLED !== "true") return json({ error: "disabled" }, 503);

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.SUBSCRIBE_LIMITER.limit({ key: ip });
  if (!success) return json({ error: "rate_limited" }, 429);

  let body: Record<string, unknown>;
  try {
    body = request.headers.get("content-type")?.includes("application/json")
      ? await request.json()
      : Object.fromEntries(await request.formData());
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  // Honeypot: real visitors never see or fill this field.
  if (typeof body.website === "string" && body.website !== "") return json({ ok: true });

  if (!(await turnstileOk(env, String(body.turnstile ?? ""), ip))) {
    return json({ error: "challenge_failed" }, 403);
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400);
  if (body.consent !== true && body.consent !== "on" && body.consent !== "true") {
    return json({ error: "consent_required" }, 400);
  }

  const key = `signup:${email}`;
  const now = new Date();
  const existing = await env.SIGNUPS.get<Signup>(key, "json");
  if (existing && now.getTime() - Date.parse(existing.lastSentAt) < RESEND_COOLDOWN_MS) {
    // Same answer as success so the endpoint doesn't reveal who has signed up.
    return json({ ok: true });
  }

  const ttlDays = Number(env.LINK_TTL_DAYS) || 7;
  const token = await signToken(env.TOKEN_SECRET, email, now.getTime() + ttlDays * 86400_000);
  const link = `${env.SITE_URL}/api/confirm?t=${token}`;

  try {
    await env.EMAIL.send({
      from: { email: env.FROM_ADDRESS, name: env.FROM_NAME },
      to: email,
      subject: "Your DPIA screening questions from Datum Longevitus",
      text: confirmText(link, ttlDays),
      html: confirmHtml(link, ttlDays),
    });
  } catch (err) {
    console.error("send failed", (err as { code?: string }).code, (err as Error).message);
    return json({ error: "send_failed" }, 502);
  }

  const record: Signup = {
    email,
    consentVersion: env.CONSENT_VERSION,
    createdAt: existing?.createdAt ?? now.toISOString(),
    lastSentAt: now.toISOString(),
    confirmedAt: existing?.confirmedAt,
  };
  await env.SIGNUPS.put(key, JSON.stringify(record));
  return json({ ok: true });
}

async function confirm(url: URL, env: Env): Promise<Response> {
  const email = await verifyToken(env.TOKEN_SECRET, url.searchParams.get("t") ?? "");
  if (!email) {
    return html(
      "This link has expired or isn't valid. Please sign up again on the website to get a new one.",
      400,
      env,
    );
  }

  const key = `signup:${email}`;
  const record = await env.SIGNUPS.get<Signup>(key, "json");
  if (record && !record.confirmedAt) {
    record.confirmedAt = new Date().toISOString();
    await env.SIGNUPS.put(key, JSON.stringify(record));
    if (env.NOTIFY_ADDRESS) {
      await env.EMAIL.send({
        from: { email: env.FROM_ADDRESS, name: env.FROM_NAME },
        to: env.NOTIFY_ADDRESS,
        subject: `New website signup: ${email}`,
        text: `${email} confirmed their signup at ${record.confirmedAt} (consent version ${record.consentVersion}).`,
      }).catch((err: Error) => console.error("notify failed", err.message));
    }
  }

  const pdf = await env.ASSETS.fetch(new Request(new URL(env.PDF_PATH, url.origin)));
  if (!pdf.ok) return html("The document isn't available right now. Please email info@datumlongevitus.org.", 503, env);
  const headers = new Headers(pdf.headers);
  headers.set("content-type", "application/pdf");
  headers.set("content-disposition", 'inline; filename="DPIA-Screening-Questions.pdf"');
  headers.set("cache-control", "private, no-store");
  headers.set("x-robots-tag", "noindex");
  return new Response(pdf.body, { status: 200, headers });
}

// ---- Turnstile ----

async function turnstileOk(env: Env, token: string, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) {
    console.error("TURNSTILE_SECRET is not set; rejecting signup");
    return false;
  }
  if (!token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip !== "unknown") form.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const out = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (!out.success) console.warn("turnstile rejected", out["error-codes"]);
    return out.success === true;
  } catch (err) {
    console.error("turnstile verify failed", (err as Error).message);
    return false;
  }
}

// ---- signed tokens: base64url(email|expiry).base64url(HMAC-SHA256) ----

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("TOKEN_SECRET is not set");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function signToken(secret: string, email: string, expiresAt: number): Promise<string> {
  const payload = new TextEncoder().encode(`${email}|${expiresAt}`);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), payload);
  return `${b64url(payload)}.${b64url(new Uint8Array(sig))}`;
}

async function verifyToken(secret: string, token: string): Promise<string | null> {
  const [p, s] = token.split(".");
  if (!p || !s) return null;
  let payload: Uint8Array, sig: Uint8Array;
  try {
    payload = fromB64url(p);
    sig = fromB64url(s);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, payload);
  if (!valid) return null;
  const [email, exp] = new TextDecoder().decode(payload).split("|");
  if (!email || !(Number(exp) > Date.now())) return null;
  return email;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---- responses and email bodies ----

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function html(message: string, status: number, env: Env): Response {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Datum Longevitus</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#081114;color:#EEF2F1;font:16px/1.6 system-ui,sans-serif;padding:24px}main{max-width:520px}a{color:#FF6A2B}</style></head>
<body><main><p>${escapeHtml(message)}</p><p><a href="${env.SITE_URL}/">Back to datumlongevitus.org</a></p></main></body></html>`;
  return new Response(page, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function confirmText(link: string, days: number): string {
  return `Thank you for signing up to hear from Datum Longevitus.

Open this link to confirm your email address and download the DPIA screening questions:
${link}

The link works for ${days} days. If you didn't ask for this, ignore this email and we won't contact you.

Datum Longevitus
https://datumlongevitus.org`;
}

function confirmHtml(link: string, days: number): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#0B0F10;max-width:560px">
<p>Thank you for signing up to hear from Datum Longevitus.</p>
<p><a href="${link}" style="display:inline-block;background:#FF6A2B;color:#0B0F10;padding:12px 20px;text-decoration:none;font-weight:600">Confirm and download the DPIA screening questions</a></p>
<p style="font-size:14px;color:#555">The link works for ${days} days. If you didn't ask for this, ignore this email and we won't contact you.</p>
<p style="font-size:14px;color:#555">Datum Longevitus · <a href="https://datumlongevitus.org" style="color:#555">datumlongevitus.org</a></p>
</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
