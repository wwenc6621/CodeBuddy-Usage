# Change Log

[简体中文](./CHANGELOG.md) | English

All notable changes are documented in this file.

## [0.9.5]

### Fixed

- Fixed the "Failed to claim buddy credits (HTTP_403)" warning on every refresh: the buddy API uses
  **HTTP 403 to carry business results** (`claim` returns `403 {"code":403,"msg":"no unclaimed travel"}`
  when there is nothing to claim), so 403 must not take part in auth decisions. Only 401 now means the
  sign-in expired; 403 goes back to the caller and is handled via `code`/`msg`, and "nothing to claim"
  is silent again.
- `callBuddyApi` now falls back to the HTTP status when the body is not JSON, avoiding empty `HTTP_` messages.

## [0.9.4]

### Fixed

- Fixed "Login expired" being a dead end: clicking used to open the Access Token input box, while the real
  fix is "sign in again + re-read the sign-in state". Clicking the item now opens a recovery menu
  (re-read the sign-in state and refresh / paste a token / clear the manual token / open the usage page).
- Fixed the 401 retry reusing the same rejected token: `invalidateAuth()` does not lift the
  "don't read the system credential store again this session" lock by default, so the retry was guaranteed
  to fail and immediately reported "Login expired". The lock is now lifted before retrying.
- Fixed HTTP 403 being reported as an expired sign-in: a 403 may come from a gateway/WAF or from missing
  permissions, so it is no longer treated as an expired sign-in.
- Fixed the built-in SQLite parser missing the newest data: `state.vscdb` runs in WAL mode, so an
  accessToken refreshed by CodeBuddy may still live only in `state.vscdb-wal`; the old reader looked at the
  main file only and kept returning the stale token (most visible on Windows, where `sqlite3` is unavailable
  and the built-in parser is the only option).
- Fixed macOS auto-read giving up when the first candidate host has no Keychain item (reported as
  `keychain access denied`): a missing item (`security` exit code 44) shows no prompt, so the scan now
  continues with the next host, which fixes machines with several VS Code–based IDEs installed.

### Removed

- Removed the `codebuddyUsage.userAgent` setting: the UA was only bound to the sign-in session in the old
  Cookie mode, it plays no part in accessToken auth, so the built-in browser UA is always used.

## [0.9.3]

### Fixed

- Fixed Windows auto-read always failing (`credential store unavailable`): Windows PowerShell 5.1 does not
  load the `System.Security` assembly by default, so `Add-Type -AssemblyName System.Security` must be called
  before using DPAPI, otherwise the `ProtectedData` type cannot be found.

### Changed

- Failure notices now include the concrete reason (Local State path, DPAPI error summary, decryption failure, …)
  so problems can be pinpointed. On Windows a failing candidate host now falls through to the next one
  (DPAPI shows no prompt); on macOS a denied Keychain read still stops immediately to avoid repeated prompts.

## [0.9.2]

### Added

- **Automatic CodeBuddy sign-in reuse (accessToken mode)**: when the CodeBuddy extension (in VS Code) is installed and signed in,
  the extension reads the `accessToken` (JWT) from its sign-in state and calls the APIs with
  `Authorization: Bearer` — no more Cookies, and no more Cookie expiry / UA-binding pain.
- **Persistent token cache (the keychain is read once)**: the token read on the first run is cached in the
  extension's own SecretStorage (encrypted by VS Code, no authorization needed to use it), so the keychain
  is not touched again until the token nears expiry (~60 days). If a keychain read fails, the extension stops
  retrying for the session instead of repeatedly prompting.
- New `codebuddyUsage.accessToken` setting and command **`CodeBuddy Usage: Paste Access Token (when auto-read fails)`**
  as the only manual fallback; submitting an empty value clears it and retries auto-read.
- The hover tooltip shows the credential expiry (e.g. `Valid until 11-14`) on the `Remaining` row, and only
  shows "not signed in" when reading fails.
- **Windows auto-read support**: the DPAPI-protected key is read from `<userData>/Local State` (via PowerShell)
  and the sign-in state is decrypted with AES-256-GCM — no manual step at all.
- Reading state.vscdb now tries `node:sqlite` → system `sqlite3` → a **built-in minimal SQLite parser**,
  so no external command is required (Windows has no `sqlite3`).

### Changed

- **Cookie mode removed**: the `codebuddyUsage.cookie` setting and the "Set login credentials (Cookie + User-Agent)"
  command are gone; authentication is now accessToken-only.
- The "No Cookie set" notice became "No credentials found", and "Cookie expired" became "Login expired";
  the hover tooltip now also includes the concrete reason (e.g. keychain access denied).

### Notes

- Decrypting the local sign-in state requires the system keychain (macOS) — that is macOS's security model and
  cannot be bypassed. Persistent caching + "stop on failure" reduce the access rate to roughly once per 60 days;
  click "Always Allow" on the first prompt.
- Auto-read supports macOS (Keychain) and Windows (DPAPI); Linux's safeStorage uses the keyring and is not
  ported yet, so paste an `accessToken` there.
- The extension **never calls refreshToken**: CodeBuddy refreshes and writes back the token itself, so the extension
  simply re-reads it — avoiding two sides rotating each other's session.

## [0.8.3]

### Added

- When the claim response omits the credit amount, the extension now falls back to the travel
  records endpoint and reads `reward_credit` for that trip, so the notification shows the real
  amount (e.g. "Claimed 8 credits"). The `reward_credit` field of the `status` endpoint is
  always `0` in practice and cannot be used.

### Fixed

- Fixed a successful claim producing no notification at all: a missing or `0` `credit` in the
  `claim` response was treated as "nothing to claim" and silently ignored. A server-confirmed
  claim now always notifies; if the amount is unknown it notifies without an amount.
- Fixed the "once per day" claim guard skipping the second trip of a day (e.g. an overnight trip
  plus a new trip the same day, which means two claims in one day): claiming is now triggered
  when either the trip identifier changes or the trip just ended.
- Failed claims are still retried on the next refresh, but the failure warning pops up at most
  once a day instead of on every 30-minute refresh.

## [0.8.2]

### Fixed

- Fixed the travel time still being reported as 0 hours: the 0.8.1 fallback only kicked in when
  the `depart` response's duration field was `null` / `undefined`, while the server actually returns
  a placeholder `0` (and `??` does not skip `0`), so the `status` lookup was never reached.
  Now, after a successful `depart`, the duration always comes from the `status` endpoint's
  `duration_hours` (matching what the website shows); the positive value from the `depart` response
  is only used when `status` yields nothing.

## [0.8.1]

### Fixed

- Fixed the buddy-depart notification wrongly reporting "travel time 0 hours": the successful
  `depart` response does not always carry a `duration_hours` / `duration` field, and the old code
  fell back to `0`, disagreeing with the real travel time shown on the website (e.g. 2 hours).
  When the duration cannot be read from the `depart` response, the extension now re-queries the
  `status` endpoint and uses the server-registered `duration_hours`, or falls back to deriving it
  from the difference between `arrive_at` and `depart_at`, matching what the website displays.

## [0.8.0]

### Added

- **Bilingual UI (English / Simplified Chinese)**: the extension now follows the VS Code display language.
  Manifest strings use `package.nls.json` / `package.nls.zh-cn.json`; runtime strings use `vscode.l10n.t()`
  with `l10n/bundle.l10n.zh-cn.json`. English is the built-in default and requires no extra file.
- English documentation: `README.en.md` and this file.

### Changed

- Shortened the English tooltip strings (status tags, table headers, summary line, …) so the tooltip stays as compact as the Chinese one and no longer wraps inside columns.

### Fixed

- The "total" link in the hover tooltip was hard-coded to the `.cn` site; it now follows the `apiBase` setting.

## [0.7.0]

### Added

- Buddy travel notifications: when the automatic flow actually **claims credits** or **successfully dispatches the buddy**,
  an information notification pops up, consistent with the check-in one (merged into a single summary per refresh).
- Manually clicking "Claim" / "Depart" in the tooltip now always gives feedback:
  success / nothing to claim / failure are all reported (previously the `0 credits` and failure branches were completely silent).

### Fixed

- Buddy claim and depart failures were only written into the tooltip tag with no notification at all, so they were easy to miss.

### Docs

- Fixed a self-contradictory statement in the README's "automatic check-in" section: only an already-completed check-in is silent; the first successful claim does notify.

## [0.5.0]

### Added

- **Configurable User-Agent**: new `codebuddyUsage.userAgent` setting.
  The server binds the full UA when issuing a session and returns 401 on any mismatch,
  and neighbouring Chrome versions are not interchangeable. Leave it empty to use the built-in default `Chrome/153`.
- Setting credentials now shows two input boxes in a row (Cookie → User-Agent) with `(1/2)` `(2/2)` in the titles;
  pressing `Esc` at any step cancels the whole flow, so a half-mismatched pair is never written.
- The actually effective UA version is echoed back after saving, so you can confirm it was written.

### Changed

- The command `Set login Cookie` was renamed to `Set login credentials (Cookie + User-Agent)`.
- README gained an "About User-Agent" section describing the observed session-binding behaviour.

### Fixed

- Fixed "the pasted User-Agent reverts to the default": the previous Webview form used
  `retainContextWhenHidden: false`, so hiding the panel (switching to the browser to copy)
  destroyed the JS context and rebuilding it reset the input. Replaced with native input boxes,
  which have no such lifecycle issue.

## [0.4.0]

### Added

- Buddy travel: claims credits and dispatches the buddy automatically; the tooltip shows the countdown and manual action links.
- The tooltip footer shows today's check-in status tag.

## [0.3.0]

### Added

- Automatic daily check-in to claim credits.
