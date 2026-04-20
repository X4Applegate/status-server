# Caddy TLS Cert — Full Chain Setup & Renewal

If you proxy status-server through Caddy (or Caddy UI / nginx-proxy-manager style) and you upload your own TLS certificates from a commercial CA like **ZeroSSL**, **Sectigo**, **GoDaddy**, etc., you **must** paste the *full certificate chain* into Caddy — not just the leaf certificate.

This doc explains why, how to spot the problem, and exactly what to do.

---

## Why this matters

Browsers like Chrome and Firefox are forgiving: if your server sends an incomplete chain, they can often fetch the missing intermediate certificate from the AIA (Authority Information Access) extension at runtime and complete the chain themselves. **Your pages still load green.**

Most server-side HTTP clients — including **Node.js `fetch` (undici)**, **Python `requests`**, **Go's `net/http`**, and others — do **not** do AIA fetching. They only trust what the OS/container trust store already has. If the intermediate is missing from both the server's response and the client's trust store, the TLS handshake fails.

status-server runs inside a Node.js container and calls Omada controllers, webhooks, badge endpoints, and other HTTPS destinations via `fetch`. If any of those are fronted by a Caddy instance serving only the leaf certificate, status-server will log the cryptic error:

```
fetch failed
```

…with no HTTP status code, no SSL error detail, nothing. Browsers may work fine while status-server silently fails to reach the same URL.

---

## Symptoms

- Omada controllers, webhooks, or custom HTTP checks keep flapping or show `DOWN` with no obvious reason
- status-server logs show `fetch failed` (generic undici network error) with no HTTP code
- The same URL works from:
  - A browser
  - `curl` on your laptop
  - `wget` on the host machine (outside the container)
- But the same URL fails from:
  - `docker exec status-server wget <url>`
  - `docker exec status-server node -e "fetch('<url>').then(r=>console.log(r.status))"`

When your own hostname resolves to your own server's public IP, you might think it's a NAT hairpin issue — it usually isn't. It's almost always the TLS chain.

---

## Diagnosing the chain

Run this from anywhere with `openssl`:

```bash
echo | openssl s_client -connect example.com:443 -servername example.com -showcerts 2>/dev/null \
  | grep -cE "^-----BEGIN CERTIFICATE-----"
```

Interpret the count:

| Count | Meaning |
|:-:|---|
| `0` | Can't reach the server at all (DNS / firewall / Caddy down) |
| `1` | **Chain is incomplete** — only the leaf. Fix this. |
| `2` | Leaf + intermediate. Normal and correct for most CAs. |
| `3` | Leaf + two intermediates. Also fine — some CAs use two tiers. |

If you want to see the actual certificate subjects:

```bash
echo | openssl s_client -connect example.com:443 -servername example.com -showcerts 2>/dev/null \
  | grep -E "^(s:|i:)"
```

`s:` is subject, `i:` is issuer. The leaf's `i:` should match the intermediate's `s:`, and the intermediate's `i:` should match a root CA that's pre-installed on standard systems.

---

## Building `fullchain.pem` — the one file you actually need

When your CA delivers certs, they usually give you three or four separate files:

| File (common names) | What it is |
|---|---|
| `certificate.crt`, `<domain>.crt`, `cert.pem` | The leaf certificate (your domain) |
| `ca_bundle.crt`, `<domain>.ca-bundle`, `chain.pem`, `intermediate.crt` | The intermediate CA cert |
| `private.key`, `<domain>.key` | Your private key |
| `fullchain.pem` *(not always provided — sometimes you have to build it)* | Leaf + intermediate concatenated |

**`fullchain.pem` is just the leaf followed by the intermediate, in one PEM blob, in that order.**

### PowerShell (Windows)

```powershell
Get-Content certificate.crt, ca_bundle.crt | Set-Content fullchain.pem
```

### CMD (Windows)

```cmd
type certificate.crt ca_bundle.crt > fullchain.pem
```

### bash / zsh (Linux, macOS)

```bash
cat certificate.crt ca_bundle.crt > fullchain.pem
```

### Manual (any OS, no terminal needed)

1. Open `certificate.crt` in a text editor → copy all contents
2. Open `ca_bundle.crt` in a text editor → copy all contents
3. In a new file, paste the leaf first, then the intermediate below it
4. Save as `fullchain.pem`

Final file content should look like:

```
-----BEGIN CERTIFICATE-----
MIID... (leaf cert for your.domain.com)
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIE... (intermediate CA cert)
-----END CERTIFICATE-----
```

**Order matters.** Leaf first, intermediate second. If you swap them, Caddy will reject it with:

```
tls: private key does not match public key
```

…because Caddy treats the *first* certificate as "the certificate" and tries to match it against your private key — the intermediate's public key will never match your leaf's private key.

---

## Uploading to Caddy UI

1. Caddy UI → **Certificates** → **Add Certificate** (or edit the existing one)
2. Pick **Custom** (not Let's Encrypt)
3. **Certificate** field → paste the contents of `fullchain.pem`
4. **Certificate Key** field → paste the contents of `private.key`
5. Save

Then edit the relevant proxy host and select this certificate under **TLS Certificate**.

---

## Verifying after upload

```bash
echo | openssl s_client -connect your.domain.com:443 -servername your.domain.com -showcerts 2>/dev/null \
  | grep -cE "^-----BEGIN CERTIFICATE-----"
```

Should now print `2` or more.

From inside the status-server container:

```bash
docker exec status-server wget -qO- https://your.domain.com/some-path
```

Should return whatever the backend normally returns, without silent failure.

---

## The easier alternative: Auto SSL (Let's Encrypt)

If your domain is publicly resolvable and port 80 is reachable from the internet, you can skip all of the above by letting Caddy issue certificates itself:

- Caddy UI → edit proxy host → check **Auto SSL (Let's Encrypt)**
- Leave the TLS Certificate dropdown alone
- Save

Caddy will automatically:
- Issue the cert via ACME
- Serve the full chain (no manual concat)
- Auto-renew every ~60 days, forever

Use a commercial/wildcard cert only when you specifically need one of:
- **Wildcard coverage** (`*.example.com`) without paying for DNS-01 on every subdomain
- **Hostnames that aren't public-resolvable** (internal DNS, LAN-only)
- **An extended-validation (EV / OV) cert** for corporate/branding reasons
- **CAs other than Let's Encrypt / ZeroSSL** (policy constraint)

For most self-hosting cases, Auto SSL is strictly better.

---

## Renewal checklist

Commercial certs typically expire every 90 days (ZeroSSL free tier) or 12 months (paid). When renewal time comes:

1. Download the new cert bundle from your CA
2. Rebuild `fullchain.pem` using the same command as above:
   ```powershell
   Get-Content certificate.crt, ca_bundle.crt | Set-Content fullchain.pem
   ```
3. Caddy UI → Certificates → edit the existing cert → replace the **Certificate** field contents with the new `fullchain.pem` contents
4. Replace the **Certificate Key** field contents with the new `private.key` contents
5. Save
6. Verify:
   ```bash
   echo | openssl s_client -connect your.domain.com:443 -servername your.domain.com -showcerts 2>/dev/null \
     | grep -cE "^-----BEGIN CERTIFICATE-----"
   ```
   Still `≥2`.

Consider setting a reminder 2 weeks before expiry, and keep a small script or text note with the exact commands so you don't have to remember them each time.

---

## Troubleshooting

**`tls: private key does not match public key`** when saving in Caddy UI
→ The certs in your Certificate field are in the wrong order, or you pasted only the intermediate. Leaf must be first.

**`fetch failed`** in status-server logs for specific hosts only
→ Run the openssl chain check against those hosts. `1` = missing intermediate. Fix by building `fullchain.pem` and re-uploading.

**Chain looks right via openssl but status-server still fails**
→ Rare, but possible if the CA root itself isn't in your status-server container's trust store. Rebuild with an updated `ca-certificates` package, or set **Verify TLS off** on that specific check as a fallback (Admin → edit the check → uncheck Verify TLS).

**Browser works, `curl` works, but Node/status-server fails**
→ Classic symptom of missing intermediate. Browsers do AIA fetching, curl uses the system trust store (which may include more CAs than the container), Node's undici is strict and uses only what's in the container image. Fix the chain.

---

## Background: why server-side clients are stricter

When a TLS server presents a certificate, it's *supposed* to send:

1. The leaf cert (its own)
2. Every intermediate cert needed to chain up to a trusted root
3. **NOT** the root itself (the client already has it)

If the server only sends #1, the client has to figure out #2 on its own. The leaf's AIA extension contains a URL where the intermediate can be downloaded — browsers do this automatically. Most server-side HTTP libraries consider it too slow / risky / unnecessary and skip it.

Sending the correct chain is the server's responsibility. Caddy can't do it for you if you upload only a leaf cert.

This is also why Let's Encrypt's certbot saves `fullchain.pem` by default — it's trying to save you from this exact class of bug.
