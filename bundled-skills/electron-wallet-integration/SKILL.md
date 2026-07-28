---
name: electron-wallet-integration
description: |
  How to integrate browser extension wallets (CIP-30 Cardano, MetaMask EIP-1193)
  into Electron apps, and how to diagnose/fix "No handler registered" wallet
  bridge errors. Covers the Vite stale-.js-shadowing pitfall.
trigger: |
  When integrating browser extension wallets into an Electron app, or when
  wallet IPC bridges throw "No handler registered" errors.
dependencies: []
---

# Electron Web3 Wallet Integration

## Overview

Browser extension wallets (Lace, Nami, Eternl, MetaMask) inject APIs into the
**browser window**, not the Electron main process. In Electron, the renderer
process can access `window.cardano` or `window.ethereum` **directly** — no IPC
bridge is strictly required. Many Stargate-style codebases wrongly wrap these
in `electronAPI.cardano.*` IPC handlers that are either missing or broken.

## Core Rule: Prefer Direct Browser API (when possible)

When a wallet integration fails with `Error: No handler registered for 'cardano:detectWallets'`,
the fix is **not** to add a main-process handler. The fix is to bypass the IPC
bridge entirely and call the wallet's browser API directly.

> **Exception:** Some wallets (e.g. 1AM Wallet) use browser extensions that **cannot inject** into an Electron renderer loading local files. For these, the `window.provider` approach fails at runtime even though it compiles. See the **Iframe Bridge Pattern** section at the end of this skill.

### CIP-30 Cardano Pattern (Direct Access)

```typescript
// src/services/CardanoWalletService.ts
export class CardanoWalletService {
  async detectWallets(): Promise<DetectedWallet[]> {
    const cardano = (window as any).cardano;
    if (!cardano) return [];
    return Object.entries(cardano)
      .filter(([_, v]: [string, any]) => v?.name && v?.enable)
      .map(([key, w]: [string, any]) => ({ key, name: w.name }));
  }

  async connectWallet(walletName: string): Promise<WalletSession> {
    const cardano = (window as any).cardano;
    const wallet = cardano?.[walletName];
    if (!wallet?.enable) throw new Error(`${walletName} not found`);
    const api = await wallet.enable();
    const address = await api.getUsedAddresses();
    const balance = await api.getBalance();
    return { connected: true, address: address[0], balance, assets: [] };
  }
}
```

### Why IPC Bridges Break

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| `No handler registered for 'cardano:detectWallets'` | `preload.ts` exposed `cardano.detectWallets` but `main.ts` has zero `ipcMain.handle('cardano:*', ...)` | Replace IPC call with direct `window.cardano` detection in renderer |
| `cardano:connectWallet` returns `undefined` | Preload uses `ipcRenderer.invoke` but main process never registered the handler | Same — bypass IPC |
| QR pairing hangs forever | Mobile QR flow requires a running relay server that doesn't exist | Remove QR option; extension wallets don't need it |

### Migration Checklist

When removing a broken IPC-based wallet integration:

1. **Remove** all `window.electronAPI?.cardano?.*` calls from the component
2. **Replace** with direct service call (e.g. `cardanoWallet.connectWallet('lace')`)
3. **Remove** QR-related state (`showQRModal`, `qrData`, `isConnectingTokeo`)
4. **Remove** QR modal component entirely (~150 lines typical)
5. **Remove** `import QRCode from 'qrcode'` if no longer used elsewhere
6. **Add** `import { cardanoWallet } from '../services/AdaPortal/CardanoWalletService'`
7. **Verify** with `npm run typecheck && npm run build && npm run build:electron`
8. **Grep** built bundle for removed strings to confirm no stale references

## Vite Build Pitfall: Stale `.js` Files Shadow `.ts` Source

Vite's `resolve.extensions` prioritizes `.js` over `.ts` in some configurations.
If a `.js` compiled artifact exists next to its `.ts` source, Vite will load the
stale `.js` and ignore your edits to the `.ts` file.

### Detection

```bash
# Find stale shadow files
find src -name "*.js" -not -path "*/node_modules/*"

# Check if bundle contains expected new strings
grep -o "ExpectedNewString" dist/renderer/assets/index-*.js | wc -l
```

### Fix

```bash
rm src/types/ai.js src/components/tool-ui/types.js src/components/tool-ui/index.js
npm run build
```

### Prevention

Add to `vite.config.ts`:
```typescript
resolve: {
  extensions: ['.tsx', '.ts', '.jsx', '.js'],  // .ts before .js
}
```

Or configure `.gitignore` to exclude compiled `.js` artifacts in `src/`.

## Verification After Wallet Changes

```bash
# Clean rebuild
rm -rf dist/
npm run typecheck
npm run build
npm run build:electron

# Confirm removed strings are gone
grep -oi "tokeo\|qrmodal\|showqrmodal" dist/renderer/assets/index-*.js | wc -l
# Expected: 0

# Confirm new strings are present
grep -oi "cardanowallet\|lacConnected\|connectWallet" dist/renderer/assets/index-*.js | wc -l
# Expected: >0
```

## Race Condition: "No handler registered" But Code IS in Bundle

A subtler variant: the IPC handler code **exists** in `main.ts` and is present in
the built bundle, but the renderer calls the channel **before** the handler
registration function executes.

**Symptom:** `Error: No handler registered for 'tools:execute'` even though
`grep "tools:execute" dist/main/main.js` returns results.

**Root cause:** The registration function (`registerIPCHandlers()`) is called
**inside** an async `initializeAll()` or similar method. The renderer window
loads and sends IPC immediately, but `main.ts` hasn't reached the line that
registers the handler yet.

**Detection:**
```bash
# 1. Confirm handler code exists in bundle
grep -n "tools:execute" dist/main/main.js

# 2. Check WHERE it's called from — inside an async init method?
grep -n "registerIPCHandlers\|initializeAll\|initializeTools" dist/main/main.js

# 3. If it's only inside an async method → race condition
```

**Fix:** Move `registerIPCHandlers()` into the class **constructor** so handlers
are registered the instant the class is instantiated, before any async
initialization or window creation.

```typescript
// BEFORE (race-prone)
class ToolRegistry {
  private registerIPCHandlers() {
    ipcMain.handle("tools:execute", ...);
  }
  async initializeAll() {
    await this.initModules();
    this.registerIPCHandlers();  // ← too late! window already loaded
  }
}
const registry = new ToolRegistry();
// main.ts: createWindow() runs BEFORE registry.initializeAll() finishes

// AFTER (race-safe)
class ToolRegistry {
  constructor() {
    this.registerIPCHandlers();  // ← handlers exist immediately
  }
  private registerIPCHandlers() {
    ipcMain.handle("tools:execute", ...);
  }
  async initializeAll() {
    await this.initModules();  // ← modules init separately, handlers already registered
  }
}
const registry = new ToolRegistry();  // ← handlers registered here
// main.ts: createWindow() runs after, IPC safe
```

**Why this works:** `ipcMain.handle()` is synchronous — it just adds a callback
to Electron's internal map. There's no async work needed to register a handler,
so doing it in the constructor is safe and eliminates the race.

**Verification after fix:**
```bash
grep -n "new ToolRegistry\|registerIPCHandlers" dist/main/main.js
# Both should appear. If registerIPCHandlers is inside an async method,
# check that the constructor calls it (look for constructor pattern in compiled JS)
```

## When Direct Access Fails: In-Process WebView Bridge via `session.loadExtension()` (Canonical for Electron)

For Manifest-V3 wallet extensions that cannot inject into the Electron renderer
or a `srcdoc` iframe, the canonical fix is to **load the extension directly into
Electron's own session** and open a dedicated `BrowserWindow` to a real
`http://` origin where the extension's content script can inject.

### Why this beats the external-browser bridge

| Concern | External Chrome | In-process WebView |
|---------|---------------|-------------------|
| Requires Chrome as default browser | ✅ Yes | ❌ No |
| Spawns external process | ✅ Yes | ❌ No |
| MV3 service-worker timing issues | 🟡 Still present | 🟢 Extension loaded in Electron's session |
| Can auto-connect without user popup | ❌ No | ✅ Yes, once enabled |
| Preload/IPC complexity | Medium | Medium |
| Needs real `http://` origin | ✅ Yes | ✅ Yes |

### Critical requirement: real `http://` or `https://` origin

MV3 content scripts only inject into `http://`/`https://` URLs. Do **not** load
the bridge page from a `data:text/html,...` URL — the content script will never
fire and `window.cardano` / `window.oneam` will remain `undefined`.

**Correct:** serve bridge HTML from a temporary local HTTP server:

```typescript
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(BRIDGE_HTML);
  } else { res.writeHead(404); res.end(); }
});
server.listen(19666, '127.0.0.1', () => { ... });
await bridgeWindow.loadURL('http://127.0.0.1:19666/');
```

### Do not use the external Chrome bridge as a fallback for 1AM/MV3 wallets

The external Chrome bridge (spawn Chrome + localhost HTTP server) was tried as a
fallback for 1AM Wallet and consistently opened **Lace** instead of 1AM because:
- It loads the user's entire Chrome profile, including Lace, Eternl, Yoroi, etc.
- Its auto-connect regex originally matched `/oneam|midnight|lace/i`
- Lace's service worker activates immediately, while 1AM's MV3 service worker
  requires a user click on the extension icon first
- The bridge cannot activate the 1AM service worker from a localhost page

**Rule:** For MV3 wallets like 1AM, use **only** the in-process WebView bridge
via `session.loadExtension()`. Remove the external Chrome fallback from the
primary connect flow. Keep Chrome bridge only as a manually-triggered separate
action for wallets that inject reliably into `http://*/*` pages.

### Show the WebView bridge window

Keep the bridge `BrowserWindow` visible (`show: true`), not hidden, so the user
can:
- See which providers were detected
- Click a different wallet if the target didn't auto-connect
- Confirm whether the extension content script injected at all
- Wake an MV3 service worker by clicking the extension icon, then retry via the
  bridge UI

### Scope extension discovery to the target wallet

Only load the wallet you intend to connect. Loading every Cardano extension
(Lace, Eternl, Yoroi, etc.) causes the bridge to enumerate multiple providers
and may auto-connect the wrong one.

```typescript
function scanExtensionDirectory(extPath: string) {
  // Only pick extensions whose name/description matches the target wallet
  const text = (manifest.name + ' ' + manifest.description).toLowerCase();
  if (/1am|midnight/i.test(text)) {
    return { name: manifest.name, path: versionDir };
  }
}
```

### Provider prioritization and auto-connect rules

When multiple CIP-30 providers appear, always prefer the target wallet by name:

```typescript
const oneam = providers.find(
  w => /oneam|midnight/i.test(w.key) || /oneam|midnight/i.test(w.name)
);
const target = oneam || providers[0];
```

For the primary 1AM/Midnight flow, **do not include `lace` in the auto-connect
regex**. Lace is a different wallet even though it has some Midnight support.
If no 1AM/Midnight provider is detected, show the detected providers and wait for
user selection rather than auto-connecting Lace.

```typescript
// WRONG — auto-connects Lace when 1AM is absent
const oneamProvider = providers.find(p => /oneam|midnight|lace/i.test(p.key));

// RIGHT — only auto-connects 1AM/Midnight
const oneamProvider = providers.find(p => /oneam|midnight/i.test(p.key));
const target = oneamProvider || (providers.length === 1 ? providers[0] : null);
if (target && !/lace/i.test(target.key) && !/lace/i.test(target.wallet?.name || '')) {
  // auto-connect
}
```
await loader(extensionPath, { allowFileAccess: true });
```

Electron will log warnings about unknown permissions (`sidePanel`, `windows`)
for many extensions. These are harmless and can be ignored.

### Provider prioritization

When multiple CIP-30 providers appear, always prefer the target wallet by name:

```typescript
const oneam = providers.find(
  w => /oneam|midnight/i.test(w.key) || /oneam|midnight/i.test(w.name)
);
const target = oneam || providers[0];
```

### Preload path resolution (dev vs packaged)

The hidden bridge window uses `contextIsolation: true` and a preload script.
In dev, the source file lives under `electron/integrations/...`; in packaged
builds it must be included as an `extraResource` in `forge.config.js`:

```javascript
extraResource: [
  'electron/integrations/oneam/cip30-bridge-preload.js',
]
```

Search multiple candidate paths at runtime to handle both cases:

```typescript
const candidates = [
  path.join(__dirname, 'cip30-bridge-preload.js'),
  path.join(__dirname, '..', '..', 'electron', 'integrations', 'oneam', 'cip30-bridge-preload.js'),
  path.join(app.getAppPath(), 'electron', 'integrations', 'oneam', 'cip30-bridge-preload.js'),
  path.join(process.resourcesPath || '', 'app.asar.unpacked', 'cip30-bridge-preload.js'),
];
```

### Backfilling missing `cardano:*` IPC handlers

If the renderer still calls legacy `window.electronAPI.cardano.*` channels
(e.g., for LACE or a shared wallet surface), but the main process never
registered handlers, implement them as thin wrappers around the same WebView
bridge:

```typescript
// electron/integrations/cardano/ipcHandlers.ts
ipcMain.handle('cardano:detectWallets', async () => {
  const detected = await bridgeDetectWallets();
  return { success: true, data: detected };
});
ipcMain.handle('cardano:connectWallet', async (_event, walletKey) => {
  const result = await bridgeConnectWallet(walletKey);
  return { success: result.success, data: result, error: result.error };
});
ipcMain.handle('cardano:disconnectWallet', async () => {
  await bridgeDisconnect();
  return { success: true };
});
```

Register these **before** `createWindow()` or `initPlugins()` so the renderer
can call them on first render without "No handler registered" races.

### Full implementation template

See `references/webview-loadextension-bridge.md` for a production-ready
`CIP30WebViewBridge.ts` with HTTP server, extension discovery, scoped loading,
provider prioritization, and IPC wiring (session 2026-07-20, verified against
upstream Mosaic Companion stargate-module pattern).

See `references/1am-webview-bridge-lessons-2026-07-20.md` for the specific
session where the WebView bridge fell back to Chrome and opened Lace instead of
1AM — includes the exact symptoms, root causes, fixes, and verification steps.

### Restart requirement

The bridge HTML and main-process code do **not** hot-reload in Electron dev
mode. Always restart Electron (`Ctrl+C`, `npm run dev`) after changing bridge
or IPC handler code.

## When Direct Access Fails: External Browser Bridge (Fallback)

When both direct `window.provider` access **and** the in-process WebView bridge
fail (e.g., the MV3 extension's service worker does not fully activate inside
Electron's session), use the **external browser bridge**: Electron spawns Chrome
with a bridge page served from a temporary localhost HTTP server.

### Important: default Chrome profile has all extensions

Spawning Chrome **without** `--user-data-dir` opens the user's default profile.
This is usually necessary because a fresh temp profile contains no extensions
and the bridge will report "No wallet providers found". However, the default
profile also loads Lace, NUFI, Eternl, and other wallets. The bridge page must
therefore:

1. Filter provider buttons to the target wallet only.
2. Label each button with the actual provider key.
3. Re-detect providers immediately before `enable()` to avoid stale objects.
4. Retry `enable()` once after ~800 ms.
5. Send the real error message back to the main process.

See `references/chrome-bridge-provider-filtering-2026-07-20.md` for the exact
symptoms and fixes from the Mosaic Companion 1AM Wallet session (2026-07-20).

**Why iframe fails for some extensions:**
- 1AM Wallet and other strict extensions don't inject into `about:srcdoc` or `null` origin contexts
- They require a real `http://` or `https://` origin
- The iframe sandbox blocks the extension's content script injection
- **Deep inspection required:** Some extensions expose zero enumerable methods (`Object.keys(provider).filter(k=>typeof provider[k]==='function')` returns `[]`) while the real API is hidden on the prototype chain or as non-enumerable properties. See the `wallet-dapp-integration` skill → `references/exhaustive-wallet-api-discovery.md` for the `getAllPropertyNames()` helper that walks the full prototype chain.

**The fix:**
```
Electron renderer          Main Process                Chrome Browser
     |                         |                            |
     |-- ipcRenderer.invoke --->|                            |
     |   "wallet:openExternal"   |                            |
     |                         |-- http.createServer()       |
     |                         |   listen(0) → random port   |
     |                         |                            |
     |                         |-- shell.openExternal()     |
     |                         |   http://127.0.0.1:PORT     |
     |                         |--------------------------->|
     |                         |                            |
     |                         |                            | bridge.html loads
     |                         |                            | extension injects
     |                         |                            | window.oneam here
     |                         |                            |
     |                         |                            | POST /callback
     |                         |<--------------------------|
     |                         |   {address, balance, ...}    |
     |                         |                            |
     |<-- resolve IPC ---------|                            |
     |   {connected:true,...}  |-- server.close()           |
```

**Implementation:** See `wallet-dapp-integration` skill → `references/1am-chrome-bridge-implementation.md` for the full production-ready `http.createServer()` + `spawn()` + bridge HTML + IPC wiring template (session 2026-07-20, verified against upstream stargate-module pattern).

**Key differences from iframe bridge:**

| Approach | Extension Injection | User Popup | Works? |
|----------|-------------------|------------|--------|
| Direct `window.oneam` in React | ❌ No (local context) | N/A | ❌ |
| iframe `srcdoc` bridge | ⚠️ Sometimes | ⚠️ May be blocked | 🟡 |
| In-process WebView via `session.loadExtension()` | ✅ Yes | ✅ Once enabled | ✅ |
| **External browser + localhost server** | ✅ Yes | ✅ Opens normally | ✅ |

### External browser bridge pitfalls

1. **Zero enumerable methods** — `Object.keys(provider)` may return `[]`. Use `getAllPropertyNames()` (prototype chain + non-enumerable + Symbol keys). See `wallet-dapp-integration` → `references/exhaustive-wallet-api-discovery.md`.
2. **Variable scoping in embedded templates** — The bridge HTML is a string template inside TypeScript. Variables declared with `const`/`let` inside an `if` block are block-scoped. If you reference them in the report object outside that block, you get `ReferenceError: balMethod is not defined`. Always declare report variables at function scope.
3. **Port already in use** — Use `server.listen(0)` to bind a random available port
4. **Firewall blocking localhost** — Use `127.0.0.1` not `localhost` (some systems resolve differently)
5. **CORS preflight** — Handle `OPTIONS` requests with 204 + `Access-Control-Allow-Origin: *`
6. **Server cleanup** — Always call `server.close()` after callback or timeout
7. **User closes Chrome** — The 5-minute timeout rejects the IPC promise; show error toast
8. **Default browser not Chrome** — `shell.openExternal()` uses system default. If the extension is Chrome-only, user needs Chrome as default or copy the URL manually.
9. **Electron restart required** — The bridge HTML is embedded in main-process code. Main process does NOT hot-reload in dev mode. Always restart Electron (`Ctrl+C`, `npm run dev`) after changing bridge code.
10. **Dead IPC channel cleanup** — When removing a wallet integration, preload.ts IPC channels and global.d.ts declarations often survive. Use the cleanup pattern in `wallet-dapp-integration` → `references/stale-mcp-plugin-cleanup.md`.
11. **MV3 service worker not yet activated** — Manifest-V3 extensions (1AM Wallet, Lace in some builds) do **not** inject their content scripts into the bridge page until the user has clicked the extension icon at least once. The bridge page may report "Not detected" even though the extension is installed. Provide a **Retry** button and instructions: "Click the extension icon in Chrome, then click Retry." Do not auto-retry in a tight loop; wait for explicit user interaction.
12. **Callback must check response status and retry** — `fetch('/callback')` can silently fail if the Node server hasn't started the request handler yet or if the main-process polling loop consumes the result before the response completes. Always check `resp.ok`, log status, and retry once after a short delay. See `references/mv3-bridge-robustness.md`.
13. **Don't kill Chrome on success** — If the main process kills the spawned Chrome process as soon as it receives the callback, the user never sees the "Connected" confirmation, and any in-flight extension popup interaction may be aborted. Close only the HTTP server; let Chrome live until the user closes it.
14. **Provider filtering and labeling** — The default Chrome profile loads all extensions. The bridge page must filter to the target wallet, label buttons with the actual provider key, re-detect before `enable()`, and surface real errors. See `references/chrome-bridge-provider-filtering-2026-07-20.md`.

See `references/mv3-bridge-robustness.md` for a copy-paste bridge callback pattern and MV3 service-worker handling template.

### Chrome bridge provider-filtering checklist

When spawning an external Chrome browser as a wallet bridge (the fallback for
MV3 wallets that cannot load into Electron's session), the bridge page must
actively filter and label providers:

1. **Filter buttons to the target wallet only.** Do not render Lace, NUFI,
   Eternl, or generic `app` providers as 1AM connection options.
2. **Label each button with the actual provider key**, not just `wallet.name`.
   Multiple providers can share the same display name.
3. **Re-detect providers immediately before `enable()`**, because the provider
   object captured at page-load can go stale.
4. **Retry `enable()` once** after ~800 ms if the first call fails, to give an
   MV3 service worker time to wake.
5. **Send the real error message** back to Mosaic so the UI can display it.

See `references/chrome-bridge-provider-filtering-2026-07-20.md` for the exact
session, code, and verification steps (Mosaic Companion PR #95, 2026-07-20).

## When Direct Access Fails: Iframe Bridge Pattern (Lightweight Fallback)

Some wallet extensions (e.g., MetaMask in some builds) **can** inject into an
iframe `srcdoc` context. Use this as a quick test before trying the heavier
external browser bridge:

```typescript
class WalletBridgeService {
  private iframe: HTMLIFrameElement | null = null;

  mountBridge(container: HTMLElement): Promise<boolean> {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;';
    iframe.srcdoc = BRIDGE_HTML;
    container.appendChild(iframe);
    this.iframe = iframe;
    return new Promise((resolve) => {
      const onMsg = (e: MessageEvent) => {
        if (e.data?.source === 'wallet-bridge') {
          window.removeEventListener('message', onMsg);
          resolve(true);
        }
      };
      window.addEventListener('message', onMsg);
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve(false); }, 3000);
    });
  }

  sendCommand(cmd: string, args?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = `${cmd}_${Date.now()}`;
      const handler = (e: MessageEvent) => {
        const d = e.data;
        if (!d || d.source !== 'wallet-bridge' || d._id !== id) return;
        window.removeEventListener('message', handler);
        d.type?.endsWith('-error') ? reject(new Error(d.payload?.error)) : resolve(d.payload);
      };
      window.addEventListener('message', handler);
      setTimeout(() => { window.removeEventListener('message', handler); reject(new Error('Timeout')); }, 15000);
      this.iframe?.contentWindow?.postMessage({ source:'wallet-parent', command:cmd, ...args, _id:id }, '*');
    });
  }
}
```

**Detection:**
```bash
grep -n "loadExtension" electron/main.ts     # No results = no extension loading
```

If iframe bridge produces `undefined` provider or "not detected" after 500ms,
**immediately switch to the external browser bridge** (see above).

See `references/webview-loadextension-bridge.md` for the production-ready
`session.loadExtension()` + local HTTP server + IPC wiring template (session
2026-07-20, verified against upstream Mosaic Companion stargate-module pattern).