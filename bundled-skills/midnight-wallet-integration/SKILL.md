---
name: midnight-wallet-integration
description: |
  Integrate the 1AM or Lace browser wallet into a Midnight Network dApp, Electron app,
  Chrome extension bridge, or any frontend that needs dust-free Compact contract
  deployment and circuit calls. Use this skill when the user mentions 1AM, Lace,
  window.midnight['1am'], proof providers, balanceUnsealedTransaction, ZK config hosting,
  payload encryption via signData, or Electron/Chrome wallet bridges.
---

# Midnight Wallet Integration

This skill covers end-to-end integration of the Midnight browser wallets
(`1AM` and `Lace`) into web, Electron, and Chrome-extension frontends.
It focuses on the canonical `@midnight-ntwrk/midnight-js-*` SDK patterns,
dust-free transaction flow, and practical bridge wiring.

**Shared references:**
- `references/midskills-1am-wallet.md` — extracted API tables, transaction flow, encryption helpers, and dependency list from the MIDSKILLS `1am-wallet` skill.

---

## 1. Trigger Conditions

Use this skill when the user is doing any of the following:

- Building a Midnight dApp frontend (React, Next.js, Vue, vanilla JS).
- Connecting to the `1AM` browser extension (`window.midnight['1am']`).
- Connecting to the Lace browser extension (`window.midnight.mnLace`).
- Deploying or calling Compact contracts from a frontend.
- Handling ZK proving, `FetchZkConfigProvider`, or proof providers.
- Setting up `WalletProvider`, `MidnightProvider`, or private/public state providers.
- Implementing dust-free transaction flow.
- Deriving encryption keys from `api.signData`.
- Wiring a wallet through an Electron/Chrome extension bridge.
- Hosting ZK assets (`keys/`, `zkir/`) for a dApp.

---

## 2. Wallet Detection & Connection

The extension injects asynchronously. **Poll for it; never assume it is present on page load.**

```ts
function detectWallet(): Promise<any | null> {
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      const wallet = (window as any).midnight?.['1am'];
      if (wallet) { resolve(wallet); return; }
      if (++attempts > 50) { resolve(null); return; }
      setTimeout(check, 100);
    };
    check();
  });
}

const wallet = await detectWallet();
if (!wallet) throw new Error('1AM wallet not installed');
const api = await wallet.connect('preprod'); // 'preview' | 'preprod' | 'mainnet'
```

Lace fallback: `(window as any).midnight?.mnLace`.

---

## 3. Session Setup (Provider Enumeration)

Always fetch configuration, unshielded address, and shielded addresses in parallel, then call `setNetworkId` before any other SDK operation.

```ts
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js-types';

export async function createConnectedSession(api: any): Promise<ConnectedSession> {
  const [config, unshieldedAddress, shieldedAddress] = await Promise.all([
    api.getConfiguration(),
    api.getUnshieldedAddress(),
    api.getShieldedAddresses(),
  ]);

  setNetworkId(config.networkId);

  const zkConfigProvider = new FetchZkConfigProvider(
    new URL('/contract/your-contract', window.location.origin).toString(),
    window.fetch.bind(window),
  );

  const provingProvider = await api.getProvingProvider(zkConfigProvider);

  const proofProvider = {
    async proveTx(unprovenTx: any, _config: any) {
      const { CostModel } = await import('@midnight-ntwrk/ledger-v8');
      return unprovenTx.prove(provingProvider, CostModel.initialCostModel());
    },
  };

  const walletProvider: WalletProvider = {
    getCoinPublicKey: () => shieldedAddress.shieldedCoinPublicKey,
    getEncryptionPublicKey: () => shieldedAddress.shieldedEncryptionPublicKey,
    balanceTx: async (tx: any) => {
      const txHex = toHex(tx.serialize());
      const balanced = await api.balanceUnsealedTransaction(txHex);
      if (!balanced?.tx) throw new Error('balanceUnsealedTransaction returned invalid result');
      const { Transaction } = await import('@midnight-ntwrk/ledger-v8');
      return Transaction.deserialize('signature', 'proof', 'binding', fromHex(balanced.tx));
    },
  };

  const midnightProvider: MidnightProvider = {
    submitTx: async (tx: any) => {
      const txHex = toHex(tx.serialize());
      const result = await api.submitTransaction(txHex);
      if (typeof result === 'string' && result) return result;
      if (result?.transactionId) return result.transactionId;
      if (result?.id) return result.id;
      return txHex.slice(0, 64);
    },
  };

  const publicDataProvider = createPatchedPublicDataProvider(config.indexerUri, config.indexerWsUri);

  return {
    api,
    config,
    providers: {
      privateStateProvider: createPrivateStateProvider(),
      publicDataProvider,
      zkConfigProvider,
      proofProvider,
      walletProvider,
      midnightProvider,
    },
    unshieldedAddress: unshieldedAddress.unshieldedAddress,
  };
}
```

**Hex helpers (required):**

```ts
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) throw new Error('Invalid hex string from wallet.');
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}
```

---

## 4. Dust-Free Transaction Flow

```
dApp builds unproven tx
        ↓
proofProvider.proveTx()  →  1AM / ProofStation  →  ZK proof  (~2–5s)
        ↓
walletProvider.balanceTx()  →  api.balanceUnsealedTransaction()  →  server adds dust fees
        ↓
midnightProvider.submitTx()  →  api.submitTransaction()  →  Midnight chain

Total user cost: 0 NIGHT, 0 dust.
```

`balanceUnsealedTransaction` is the fee-sponsorship step. **Never skip it.**

---

## 5. Deploy & Call Contracts

Use the low-level `createUnprovenDeployTx` + `submitTxAsync` pattern. Avoid `deployContract()` on preprod/preview because it internally calls `watchForTxData` and can block or hang when the indexer lags.

```ts
import { createUnprovenDeployTx, createUnprovenCallTx, submitTxAsync } from '@midnight-ntwrk/midnight-js-contracts';
import { sampleSigningKey } from '@midnight-ntwrk/compact-runtime';

// Deploy
const deployTxData = await createUnprovenDeployTx(
  { zkConfigProvider: session.providers.zkConfigProvider, walletProvider: session.providers.walletProvider },
  { compiledContract, args: constructorArgs, signingKey: sampleSigningKey() },
);
const contractAddress = deployTxData.public.contractAddress;
await submitTxAsync(session.providers, { unprovenTx: deployTxData.private.unprovenTx });

// Persist private state
await session.providers.privateStateProvider.setContractAddress(contractAddress);
await session.providers.privateStateProvider.setSigningKey(contractAddress, deployTxData.private.signingKey);

// Call a circuit
const callTxData = await createUnprovenCallTx(session.providers, {
  compiledContract,
  contractAddress,
  circuitId,
  args,
});
const txId = await submitTxAsync(session.providers, { unprovenTx: callTxData.private.unprovenTx, circuitId });
```

---

## 6. Patched Public Data Provider

The preview and preprod indexers have a GraphQL bug when `queryContractState` is called without a config block. Wrap the SDK provider:

```ts
import { ContractState } from '@midnight-ntwrk/compact-runtime';

export function createPatchedPublicDataProvider(queryUrl: string, subscriptionUrl: string) {
  const base = indexerPublicDataProvider(queryUrl, subscriptionUrl);

  async function queryLatest(query: string, address: string) {
    const res = await fetch(queryUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { address } }),
    });
    if (!res.ok) throw new Error(`Indexer HTTP error: ${res.status}`);
    const payload = await res.json();
    if (payload.errors?.length) throw new Error(payload.errors.map((e: any) => e.message).join('; '));
    return payload.data?.contractAction ?? null;
  }

  return {
    ...base,
    async queryContractState(contractAddress: string, config?: any) {
      if (config) return base.queryContractState(contractAddress, config);
      const action = await queryLatest(`
        query LATEST_CONTRACT_STATE($address: HexEncoded!) {
          contractAction(address: $address) { state }
        }`, contractAddress);
      return action ? ContractState.deserialize(fromHex(action.state)) : null;
    },
  };
}
```

---

## 7. Electron / Chrome Bridge Wiring

When the wallet must be accessed from an Electron renderer whose `window.midnight` object is not directly injected by the extension, build a preload proxy.

### Preload proxy shape

```ts
// preload.ts (contextIsolation: true)
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('midnight', {
  '1am': {
    async connect(networkId: string) {
      return ipcRenderer.invoke('1am:connect', networkId);
    },
    async getConfiguration()        { return ipcRenderer.invoke('1am:getConfiguration'); },
    async getUnshieldedAddress()    { return ipcRenderer.invoke('1am:getUnshieldedAddress'); },
    async getShieldedAddresses()    { return ipcRenderer.invoke('1am:getShieldedAddresses'); },
    async getProvingProvider(zkConfigProvider: any) {
      // The real provider is a host object; pass a descriptor and reconstruct on the host.
      return ipcRenderer.invoke('1am:getProvingProvider', zkConfigProvider);
    },
    async balanceUnsealedTransaction(txHex: string) {
      return ipcRenderer.invoke('1am:balanceUnsealedTransaction', txHex);
    },
    async submitTransaction(txHex: string) {
      return ipcRenderer.invoke('1am:submitTransaction', txHex);
    },
    async signData(data: string, options: any) {
      return ipcRenderer.invoke('1am:signData', data, options);
    },
  },
});
```

### Main-process host options

1. **Chrome extension bridge:** Load the 1AM/Lace extension in a hidden `BrowserView` or `WebContents`, inject a content script that exposes `window.midnight['1am']`, and relay calls via `chrome.runtime.sendMessage` / `ipcMain`.
2. **Native host binary:** If the wallet exposes a native messaging host, call it from the main process and marshal results back to the renderer.
3. **Embedded webview:** Load a trusted local page that loads the extension, perform wallet operations there, and forward results.

### CORS & asset hosting in Electron

- `FetchZkConfigProvider` performs `fetch` against `window.location.origin`. In Electron, serve assets from a localhost dev server or register a custom protocol that returns CORS headers.
- For indexer GraphQL calls, proxy them through `ipcRenderer` → `net` module to avoid renderer CORS restrictions.
- Required CORS header for ZK assets: `Access-Control-Allow-Origin: *`.

---

## 8. ZK Asset Hosting

Compiled contracts produce:

```
public/contract/your-contract/
  keys/
    circuitName.prover      # 2–10 MB
    circuitName.verifier    # ~2 KB
  zkir/
    circuitName.bzkir       # 1–3 KB
```

Make the build step copy them before dev server starts:

```json
{
  "scripts": {
    "sync:zk": "mkdir -p public/contract/your-contract && cp -r contracts/managed/your-contract/keys public/contract/your-contract/ && cp -r contracts/managed/your-contract/zkir public/contract/your-contract/"
  }
}
```

**Before debugging any provider error, open the asset URLs directly in the browser.** 404/CORS failures here surface as cryptic SDK errors.

---

## 9. Payload Encryption (Optional)

Derive an AES-GCM key from `api.signData` deterministically per wallet + network + contract.

```ts
export async function deriveContractKey(api: any, networkId: string, contractAddress: string): Promise<CryptoKey> {
  const message = `midnight-app-key|${networkId}|${contractAddress}`;
  const signature = await api.signData(message, { encoding: 'text' });
  if (!signature) throw new Error('signData returned empty — cannot derive encryption key');

  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(signature), 'HKDF', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(`midnight-salt|${networkId}`),
      info: new TextEncoder().encode(`midnight-contract|${contractAddress}`),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
```

Envelope format: `enc:v1:<base64url(iv+ciphertext)>`.

---

## 10. Dependencies

```bash
npm install \
  @midnight-ntwrk/compact-runtime@^0.15.0 \
  @midnight-ntwrk/ledger@^4.0.0 \
  @midnight-ntwrk/ledger-v8@^8.0.3 \
  @midnight-ntwrk/midnight-js-contracts@^4.0.4 \
  @midnight-ntwrk/midnight-js-fetch-zk-config-provider@^4.0.4 \
  @midnight-ntwrk/midnight-js-indexer-public-data-provider@^4.0.4 \
  @midnight-ntwrk/midnight-js-network-id@^4.0.4 \
  @midnight-ntwrk/midnight-js-types@^4.0.4 \
  @midnight-ntwrk/wallet-sdk-address-format@^3.1.0
```

Vite:
```bash
npm install -D vite-plugin-wasm vite-plugin-top-level-await
```

Next.js: requires custom webpack config for WASM, top-level await, and an `isomorphic-ws` shim. See upstream MIDSKILLS skill for details.

---

## 11. Common Pitfalls

| Pitfall | Fix |
|---------|-----|
| Wallet not detected immediately | Poll `window.midnight['1am']` for up to ~5s; extension injection is async. |
| `window.midnight['1am']` missing in Electron | Build a preload proxy that routes calls to the extension/host via IPC. |
| `setNetworkId()` not called first | Call it immediately after `getConfiguration()`. |
| Hex missing `padStart(2, '0')` | Always pad single-digit hex bytes. |
| Skipping `balanceUnsealedTransaction` | Dust fees won't be added; the tx will fail. |
| `submitTransaction` returns object | Normalize: string → `.transactionId` → `.id` → fallback `txHex.slice(0,64)`. |
| Using `deployContract()` on preprod/preview | It blocks on `watchForTxData`. Use `createUnprovenDeployTx` + `submitTxAsync`. |
| Using `createProofProvider()` from SDK types | It doesn't pass `CostModel` correctly. Use the custom `proveTx` wrapper. |
| Passing `ContractState` to `ledger()` | Pass `contractState.data` (ChargedState), not the raw `ContractState`. |
| Reading state immediately after submit | Indexer lags chain finality; always poll with a predicate. |
| ZK assets 404 / CORS | Run `sync:zk` before dev; verify URLs directly; ensure CORS header. |
| Reusing contract address after recompile | Verifier key changes; always redeploy. |
| Hardcoding indexer/RPC URLs | Read them dynamically from `api.getConfiguration()`. |
| MIDSKILLS browse UI doesn't show skill content | The registry is backed by a public GitHub repo. Clone `Kali-Decoder/Midnight-skills` and read `.agents/skills/<skill-name>/SKILL.md` directly. |

---

## 12. Reference Files

- `references/midskills-1am-wallet.md` — condensed API tables, exact transaction flow, encryption helpers, dependency list, and links extracted from the MIDSKILLS `1am-wallet` skill.
