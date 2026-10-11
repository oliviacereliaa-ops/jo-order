# JO Order

Two static web pages for taking orders and tracking production. The data lives in a Google Sheet behind a Google Apps Script web app.

| Page | What it does |
|---|---|
| `index.html` | **Order chat.** Type an order in plain words (e.g. `Offline, sage green 4x1 2 pcs @20rb for Hans, kirim Jumat`). The script turns it into an order template. Confirm it to save it to the *Order* sheet, then copy or send the WhatsApp summary. |
| `production.html` | **Production board.** Kanban with *In Queue → On Production → Done → Delivered*, estimated finish times and late flags. Refreshes every 30 s. |

There is no build step and no server of your own: the pages are plain HTML that talk to the Apps Script URL, which is already built in.

## Using it
1. Open the site. A password screen appears.
2. Enter the password. The page connects to the sheet on its own: the same password is used as the sheet PIN for that tab.
3. Each new tab or window asks for the password again. Reloading the same tab does not.

If the PIN in Apps Script ever differs from the website password, open ⚙ Settings and enter the PIN there.

## How it is protected

There are two locks:

1. **Password screen (website).** Nothing shows until the password is entered. The HTML holds only a salted PBKDF2-SHA256 hash (600k iterations). The plain password stays in your local `.env`.
   > Because this is a static site, anyone who downloads the HTML can see the code. The password screen keeps casual visitors out. It is **not** what protects your data.
2. **PIN (Apps Script).** Every request sends the PIN, and the Apps Script rejects a wrong one (`{"ok":false,"error":"Wrong PIN."}`). **This is the real protection for your orders.**

Extra hardening in the pages:
- Content-Security-Policy: the page can only talk to `script.google.com` / `script.googleusercontent.com`, and it loads no outside scripts.
- The PIN is only ever sent to a URL of the form `https://script.google.com/macros/s/…/exec`.
- The PIN, the chat history and unsaved drafts are kept for the current tab only, so closing the tab clears them. ⚙ Settings has an opt-in "Remember PIN on this device".
- `noindex` so search engines do not list the pages; `no-referrer` so the URL does not leak to other sites.

## Changing the password or script URL
```bash
cp .env.example .env          # first time only, then edit .env
python scripts/configure.py   # writes the password hash + URL into both pages
git commit -am "Update config" && git push
```
Commit the HTML, **never `.env`** (it is in `.gitignore`). Changing the password signs everyone out.

If you change the PIN, change it in Apps Script too (see the checklist below).

## Environment variables (`.env`)

| Key | Used by | Notes |
|---|---|---|
| `GATE_PASSWORD` | `scripts/configure.py` | Lock-screen password. Only its hash is published. |
| `APPS_SCRIPT_URL` | `scripts/configure.py` | Built into the pages as the default connection. |
| `APP_PIN` | Reference only | The real check happens in Apps Script. |

## Deploying the Apps Script
**Deploy → Manage deployments → Web app**: *Execute as: Me*, *Who has access: Anyone*. When you update `Code.gs`, choose **Edit → New version** on the same deployment so the URL stays the same.

## Backend checklist (`Code.gs`, not in this repo)
The PIN is 6 digits and the URL is in the public HTML, so the script is what has to stop guessing:
- [ ] **Lock out after failed PINs**, e.g. count failures in `CacheService` and refuse all requests for 15 minutes after 10 misses. Without this, a 6-digit PIN can be guessed by a script.
- [ ] Read the PIN from `PropertiesService.getScriptProperties()` instead of writing it in the code.
- [ ] Wrap PO-number generation and row writes in `LockService` so two people saving at once don't get the same PO.
- [ ] Return generic error messages (no stack traces).
- [ ] Keep any AI/API keys in Script Properties.

## Files
```
index.html            order chat
production.html       production board
scripts/configure.py  writes the password hash + script URL into both pages
.env.example          template for .env (committed)
.env                  your secrets (git-ignored)
```
