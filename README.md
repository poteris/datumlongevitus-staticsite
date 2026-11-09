# Datum Longevitus website

Static landing page (from Paula Mourad's design, [pmourad/datum-longevitus](https://github.com/pmourad/datum-longevitus)) served by a Cloudflare Worker with static assets. The Worker only handles the email signup and the gated DPIA PDF; everything else is plain files in `public/`.

```
public/                     the site, served as-is
  index.html                page, styles and animation code
  assets/                   images, logos, fonts
  downloads/                DPIA screening questions PDF (only reachable via a signed link)
  _headers                  security headers and caching
src/worker.ts               /api/subscribe, /api/confirm, blocks direct /downloads/* access
wrangler.jsonc              Worker, static assets, KV, email and rate-limit bindings, vars
.dev.vars.example           local secrets template
```

## How the signup works

1. Visitor enters an email, ticks the consent box, submits. `POST /api/subscribe` checks a per-IP rate limit (5/min), a honeypot field, the email format and consent.
2. The Worker emails a confirmation link through Cloudflare Email Service (`send_email` binding) and stores `{email, consentVersion, createdAt, lastSentAt}` in KV under `signup:<email>`. Repeat requests within 10 minutes don't resend.
3. The link is `/api/confirm?t=<token>`, an HMAC-signed `email|expiry` valid for 7 days. Opening it sets `confirmedAt`, emails a notice to `NOTIFY_ADDRESS`, and opens the PDF.
4. `/downloads/*` returns 404 when requested directly.

The PDF is in this repo, so anyone with access to the repo can read it; the gate is about capturing consent, not secrecy.

## One-time Cloudflare setup

1. **Install and log in:** `npm install`, then `npx wrangler login`.
2. **KV namespace:** `npm run kv:create`, then paste the printed `id` into `kv_namespaces` in `wrangler.jsonc`.
3. **Token secret:** `npm run secret:token` and paste a long random string (for example the output of `openssl rand -base64 48`).
4. **Email Sending:** in the dashboard, open Email Service and onboard `datumlongevitus.org` for **sending**. This adds MX/SPF on `cf-bounce.`, DKIM on `cf-bounce._domainkey.` and DMARC on `_dmarc.`; it does not touch the root MX records, so existing mail to info@ is unaffected. If a DMARC record already exists, keep one, not two.
5. **Deploy:** connect this repo under Workers & Pages → Create → Import a repository (build command empty, deploy command `npx wrangler deploy`), or run `npm run deploy` locally.
6. **Custom domain:** once `datumlongevitus.org` is a zone in the same account, uncomment `routes` in `wrangler.jsonc` and deploy, or add it under the Worker's Settings → Domains & Routes.
7. **Web Analytics:** Analytics & Logs → Web Analytics → add the site. For a domain proxied through Cloudflare, automatic setup injects the beacon. Otherwise paste the snippet it gives you before `</body>`; `_headers` already allows it in the CSP.
8. **Switch on the signup** only once the privacy notice is published: set `SIGNUP_ENABLED` to `"true"` in `wrangler.jsonc` and deploy. Until then the form says sign-up opens shortly.

## Local development

```
cp .dev.vars.example .dev.vars
npm run dev            # http://localhost:8787
```

Emails are not sent locally; Wrangler prints the paths of the rendered text and HTML instead, including the confirmation link.

## Exporting signups

`npm run signups:list` lists keys. To get records:
`npx wrangler kv key get --binding SIGNUPS --remote "signup:someone@example.org"`.
Unsubscribe requests are handled by hand for now: delete the key.
