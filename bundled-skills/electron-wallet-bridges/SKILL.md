---
name: electron-wallet-bridges
description: Integrating browser-extension wallets (CIP-30, MetaMask-style) into Electron via in-process WebView or external Chrome bridges.
title: Electron Wallet Bridges for Browser Extensions
version: 1.0
triggers:
  - electron wallet integration
  - browser extension wallet electron
  - cip-30 electron bridge
  - metamask electron integration
  - 1AM wallet electron
  - cardano wallet electron
  - mv3 extension electron
---

# Electron Wallet Bridges for Browser Extensions

See `references/1am-static-battle-test-2026-07-20.md` for the static-analysis checklist and P0/P1/P2 findings from the 2026-07-20 review of Mosaic Companion's 1AM Wallet integration.

## Core truth

- Extension wallets inject `window.cardano.*`, `window.ethereum`, `window.oneam`, etc. only into real browser rendering origins (`http://` / `https://`).
- Electron's `<webview>`, `BrowserView`, and `BrowserWindow` can load `http://` origins, but MV3 service workers may not fully activate inside Electron's `session.loadExtension()`.
- The reliable path for MV3 wallets is usually to **spawn the user's real Chrome/Brave/Chromium** and load a local HTTP bridge page there.

## Bridge strategies

### 1. In-process WebView / BrowserWindow bridge (works for some wallets)

Best for wallets whose content scripts activate reliably inside Electron.

1. Serve a local HTTP bridge page (not `data:` URL) so content scripts match `http://*/*`.
2. Load the extension into Electron's session with `session.extensions.loadExtension()` (fallback to deprecated `session.loadExtension`).
3. Bridge page enumerates `window.cardano` / `window.oneam` and reports providers to the main process via IPC preload.
4. Connect and call `enable()`, then read addresses/balances.

### 2. External Chrome bridge (more reliable for MV3)

Best for MV3 wallets like 1AM whose service workers need a real browser profile.

1. Start a tiny local HTTP server on `127.0.0.1` serving a bridge page.
2. Spawn Chrome **without `--user-data-dir`**, pointing it at that bridge URL. This uses the user's default profile where the extension is already installed and unlocked.
3. The bridge page enumerates providers, connects via CIP-30, and POSTs the result back to the local server.
4. Main process receives the result and updates app state.

**Use `localhost`, not `127.0.0.1`, for the Chrome bridge URL.** CIP-30 wallets
such as 1AM reject raw `127.0.0.1` origins with `code -2` even after the user
approves the connection. The underlying Node server can still bind to
`127.0.0.1`; the origin seen by the browser must be `http://localhost:<port>/`.

## Detection rules

- **Trust the CIP-30 key, not the display name.** A wallet whose `key` is `1am`, `oneam`, or `midnight` is the target. Other providers (e.g., key `app`, `lace`, `nufi`, `eternl`) may claim a similar `wallet.name`; do not auto-connect them.
- Filter provider lists before showing buttons. If the target key is missing, show an explicit "not found" state with instructions to wake the extension.

## Common pitfalls

| Pitfall | Why it happens | Fix |
|---------|----------------|-----|
| Wallet not detected | Using `data:` or `file://` bridge URL; content scripts only inject on `http/https`. | Serve the bridge over `http://127.0.0.1:<port>`. |
| Wallet not detected in Electron | MV3 service worker doesn't activate via `session.loadExtension()`. | Fall back to spawning real Chrome. |
| Wrong wallet auto-connects | Provider name matches, but key is `app` or `lace`. | Match only exact target keys. |
| Chrome opens with no extensions | Using `--user-data-dir=<temp>` creates a blank profile. | Spawn Chrome without `--user-data-dir` to use the default profile. |
| `enable()` fails with `[object Object]` | Caught rejection is an object, not a string. | JSON-stringify errors; check `error.message`, `error.code`, then fall back to `JSON.stringify`. |
| Stale provider object | Provider detected at page-load time is re-initialized by the extension before user clicks. | Re-detect providers immediately before calling `enable()`. |
| `enable()` rejected with code -2 after approval | CIP-30 wallets distrust raw `http://127.0.0.1` origins. | Serve and open the bridge at `http://localhost:<port>/`, not `http://127.0.0.1:<port>/`. |
| Auto-connect rejected with code -2 | `wallet.enable()` called from `setTimeout`/auto logic, not a real user gesture. | Disable auto-connect; require a manual button click inside a click event handler. |
| Multiple providers share display name "1AM Wallet" | Buttons labeled only by name are ambiguous. | Label buttons with the actual provider key: `Connect 1AM Wallet [1am]`. |
| Bridge connected but app stayed empty | Main process discarded success because `address` was empty; `getUsedAddresses()` was the only method tried. | Cache success even without address; try `getUsedAddresses`, `getUnusedAddresses`, `getChangeAddress`, `getAddresses`; log full result in main process. |
| Standard address method missing | Custom wallets expose `getUsedAddresses`, `getUnusedAddresses`, `getChangeAddress`, or `getAddresses` inconsistently, and `getRewardAddresses()` may also differ. | Guard each method with `if (api.methodName)` and fall through the list. |
| All CIP-30 data methods return `code -2` after successful `enable()` | The wallet routes private data through a proprietary `postMessage` layer, not the standard CIP-30 API. | Spy on `window.postMessage` while triggering the wallet's own calls; replicate the exact `source`/`type`/`payload` and read the response. |
| Bridge page console is hard to capture | DevTools page detection may fail; user cannot manually paste console commands. | Add a `window.postMessage` spy that logs to the page console, and/or use Chrome DevTools Protocol with `--remote-debugging-port`. Better: include all raw captures in the callback payload so they print in the main process terminal. |

## Implementation checklist

- [ ] Bridge page is served over `http://`.
- [ ] Provider detection re-runs on every connect attempt.
- [ ] Provider list is filtered to target keys only.
- [ ] `enable()` is retried once after a short delay on first failure.
- [ ] Error messages are fully stringified and logged.
- [ ] Result is POSTed back to the Electron main process reliably.
- [ ] `ipcMain.handle` is registered synchronously (constructor), not in an async init.
- [ ] External Chrome bridge uses `localhost` URL, not `127.0.0.1`.
- [ ] Auto-connect is disabled for MV3 wallets that require a user gesture.
- [ ] Multiple address-reading methods are tried; success is cached even if no address is found.
- [ ] Full bridge result is logged in main process on callback.

## References

- `references/oneam-session-2026-07-20.md` — session-specific error transcripts and 1AM provider quirks from the Mosaic Companion 1AM integration.
- `references/1am-localhost-origin-2026-07-20.md` — why 1AM rejected `enable()` with `code -2` even after approval, and the `127.0.0.1` → `localhost` origin fix (Mosaic Companion PR #95, 2026-07-20).
- `references/1am-post-connection-data-flow-2026-07-20.md` — fixing "bridge connected but Mosaic UI stayed empty": cache success without requiring an address and try multiple CIP-30 address-reading methods.
- `references/1am-postmessage-protocol-2026-07-20.md` — reverse-engineering 1AM's proprietary `postMessage` balance protocol after standard CIP-30 methods returned `code -2`.
