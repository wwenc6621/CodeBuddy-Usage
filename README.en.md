# CodeBuddy Usage (VS Code Extension)

[简体中文](./README.md) | English

Shows your CodeBuddy credit balance in the VS Code status bar, and claims the daily credits for you along the way.

---

## Zero-config start

1. Install this extension (search `CodeBuddy Usage` in the Extensions marketplace, or install the `.vsix` file)
2. Install the **Tencent Cloud CodeBuddy** extension (`tencent-cloud.coding-copilot`) inside VS Code and sign in

> Only that **VS Code extension** is needed — the WorkBuddy / CodeBuddy desktop app is **not** required.
> Its sign-in state is kept in VS Code's own credential store, and this extension reads it directly.

That's it. This extension automatically reads the sign-in state (`accessToken`) saved by that extension —
**no more copying Cookies by hand**. The CodeBuddy extension keeps the token refreshed, so what we read is always current.

> **About the domains**: Tencent's "CodeBuddy" and "WorkBuddy" share the same account system and backend,
> so signing in to either website works — no separate registration needed.
> By default this extension reads data from the WorkBuddy website (its pages offer claimable credits).

The status bar at the bottom right shows your remaining credits, e.g. `⚡ 2431.68`. Hover over it for the details:

![Status bar and tooltip](https://raw.githubusercontent.com/wwenc6621/CodeBuddy-Usage/main/resources/docs/tooltip-preview.png)

### Credential access is requested only once

The `accessToken` is stored encrypted locally (VS Code SecretStorage) and the decryption key lives in the
system credential store:

- **macOS**: the Keychain. The first read shows one prompt (it may ask for your login password) —
  click **Always Allow**;
- **Windows**: DPAPI (current-user scope) — decrypted directly, no interaction at all.

After that single read, the token is cached in the extension's own SecretStorage (using it needs no
authorization), so **the system credential store is not touched again until the token nears expiry (~60 days)**.
If a read fails, the extension will **not** keep prompting — it asks you to paste a token once instead.

### When auto-read fails: paste an Access Token

You need this fallback when: CodeBuddy is not installed, you are on **Linux** (auto-read not ported yet),
or the credential store is unavailable / access was denied.

`Cmd/Ctrl + Shift + P` → **`CodeBuddy Usage: Paste Access Token (when auto-read fails)`** → paste the JWT.
It stays valid for about 60 days; submitting an empty value clears it and retries auto-read.

---

## Everyday use

| What you want                                         | How                                            |
| ----------------------------------------------------- | ---------------------------------------------- |
| Check the balance                                     | Just look at the number in the status bar      |
| See details (total, percentage, per-package expiry)   | Hover over the status bar item                 |
| See the current account                               | The tooltip header shows the avatar + nickname (read from the CodeBuddy sign-in state, no extra API call) |
| Refresh manually                                      | Click the status bar item                      |
| Claim credits / send the buddy out manually           | Click "Claim" or "Depart" in the tooltip       |

Auto refresh runs every 30 minutes by default.

### Credits claimed for you every day

Once installed there is nothing to do — both of the following happen automatically:

- **Daily check-in** — checks in every day to claim credits
- **Buddy travel** — claims the credits your buddy earned, then sends it out on the next trip

On success a notification tells you how much you got. If there is nothing to claim, or you already claimed today, you will not be disturbed.

Hovering the status bar shows today's status at the bottom, e.g. `✓ Checked in`, `✿ Countdown 03:12:45`.

---

## Something wrong?

| Symptom                             | What to do                                                          |
| ----------------------------------- | ------------------------------------------------------------------- |
| Shows "No credentials found"        | Make sure the CodeBuddy extension is signed in inside VS Code; otherwise paste an Access Token |
| Shows "Login expired"               | The CodeBuddy extension sign-in expired — sign in again in VS Code, then click the item and pick "Re-read the sign-in state and refresh" |
| Shows "Fetch failed"                | Click the status bar item to retry                                  |
| The number never changes            | Click the status bar item to refresh manually                       |
| It asks for keychain access (macOS)  | Click "Always Allow" the first time; if it still fails, paste an Access Token |
| You use the international site      | Set `apiBase` to `https://www.workbuddy.ai`                         |

---

## Settings

Search for `codebuddyUsage` in VS Code settings:

| Setting                   | Default                      | Description                                                          |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `accessToken`             | empty                        | JWT to paste when auto-read fails. **Normally not needed**            |
| `refreshIntervalMinutes`  | 30                           | Auto refresh interval (minutes); set 0 to disable                    |
| `autoCheckin`             | on                           | Automatic daily check-in                                             |
| `buddyTravel`             | on                           | Automatic buddy travel                                               |
| `apiBase`                 | `https://www.workbuddy.cn`   | Domestic site; use `https://www.workbuddy.ai` for the international site |

## Privacy

- The extension reads the sign-in state (`accessToken`) saved by the CodeBuddy extension (inside VS Code) locally only; credentials are **never uploaded anywhere** and never pass through a third party.
- Decrypting the local sign-in state needs the system credential store (macOS Keychain / Windows DPAPI): it is read only on the first run (or when the token nears expiry) — after that you are done.
- The token is cached in the **extension's own SecretStorage** (encrypted by VS Code, still local only).
- A manually entered `accessToken` is **stored only in your local VS Code configuration**.
- Do not share these credentials. Signing out invalidates them immediately.

## Build it yourself

```bash
npm install
npm run compile   # or press F5 to debug in an Extension Development Host window
```

Package it: `npm install -g @vscode/vsce && vsce package`

## Languages

The UI follows the VS Code display language. English is the built-in default; Simplified Chinese is provided
by `l10n/bundle.l10n.zh-cn.json` (runtime strings) and `package.nls.zh-cn.json` (manifest strings).
