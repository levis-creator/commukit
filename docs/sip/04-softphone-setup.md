# 04 — Softphone Setup (for End Users)

This page is intended to be shared **with end users**, not developers.
Your consumer app can copy these instructions into its own help center
or link directly to this page.

## Prerequisites

Your admin will give you four pieces of information. They come from the
response of the `sip-credentials` endpoint or the "SIP settings" screen
in the consumer app:

| Field | Example |
|---|---|
| **SIP username** | `comms_7f3c1b2e9a4d4b56` |
| **SIP password** | (a long random string) |
| **Server / domain** | `comms.example.com` |
| **Transport** | `UDP` (or `TCP` / `TLS`) |

Keep your credentials secret — they're specific to you and give access
to audio rooms in your organization.

---

## Linphone (macOS / Windows / Linux / iOS / Android)

Linphone is the recommended free softphone. It's open source and works
on every platform.

1. Download from <https://www.linphone.org/>.
2. Open Linphone and choose **Use SIP account**.
3. Enter:
   - **Username** — the SIP username your admin gave you
   - **Password** — the SIP password
   - **Domain** — the server domain (e.g. `comms.example.com`)
   - **Transport** — match what your admin specified (usually UDP)
4. Click **Login**.
5. When you see "Registered" or a green dot, you're connected.
6. To join a room, dial: `sip:room-<ROOM_ID>@<DOMAIN>` (your app will
   tell you the exact room URI).

---

## Zoiper (macOS / Windows / iOS / Android)

Zoiper is another popular free softphone.

1. Download from <https://www.zoiper.com/>.
2. Open Zoiper and click **Settings → Accounts → Add account**.
3. Choose **SIP account**.
4. Enter:
   - **Username** — your SIP username
   - **Password** — your SIP password
   - **Domain** — the server domain
5. Expand **Advanced** and set **Transport** to match your admin's
   instructions.
6. Save. You should see "Registered" next to the account.
7. To dial a room, paste the room URI into the dial field.

---

## MicroSIP (Windows)

MicroSIP is a very lightweight Windows-only softphone.

1. Download from <https://www.microsip.org/>.
2. Open MicroSIP. Right-click in the top bar → **Add Account**.
3. Fill in:
   - **Account Name** — anything you like
   - **SIP Server** — the server domain
   - **SIP Proxy** — same as server domain
   - **Username** — your SIP username
   - **Domain** — the server domain
   - **Login** — same as username
   - **Password** — your SIP password
4. Click **Save**. You'll see a green dot when registered.
5. Dial the room URI in the address bar to join.

---

## Jitsi Desktop (macOS / Windows / Linux)

Jitsi is a fuller conferencing client with SIP support.

1. Download from <https://desktop.jitsi.org/>.
2. **File → Add new account → SIP**.
3. Enter your SIP ID as `username@domain`, password, and server.
4. Check **Registered** status.
5. Dial via **File → New Call → Enter SIP address**.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Registration failed" / "401 Unauthorized" | Double-check the username and password; they're case-sensitive. |
| "Registration failed" / "Timeout" | The server may be unreachable from your network. Try the TCP transport. |
| Registered but hear nothing after dialing | The room may not be active yet, or your mic may not be granted permission. |
| One-way audio | NAT / firewall issue. Your admin may need to enable TURN or TCP transport. |
| "Service Unavailable" when dialing a room | The room isn't active, or the Janus SIP bridge isn't registered. Contact your admin. |

## Security Notes

- Your SIP password is a **full authentication credential**. Never
  share it. If it leaks, ask your admin to rotate it.
- SIP traffic over UDP and TCP is **not encrypted in transit** unless
  your admin enables TLS. Don't discuss sensitive matters until you've
  confirmed TLS is configured.
- Hang up when you leave a room — keeping the call open counts against
  your per-user connection cap.
