---
name: api-provider-integration
description: Integrating third-party AI and API providers into applications, covering endpoint discovery, authentication pitfalls, and debugging HTTP-level failures that don't show up in SDK abstractions.
category: software-development
tags: [api, integration, debugging, fetch, http, endpoint, provider, openai-compatible]
---

# API Provider Integration

Integrating third-party AI and API providers into applications. Covers endpoint discovery, authentication pitfalls, and debugging HTTP-level failures that don't show up in SDK abstractions.

## When to Use

- Adding a new LLM / AI provider to an existing chat client
- Converting a legacy provider integration to a new architecture
- Diagnosing 405, 401, 429, or silent fetch failures
- Ported provider code is not behaving the same as the original

## Workflow: Check the Legacy Branch First

When a provider that worked in an older branch / module breaks after integration:

1. **Identify the last known working commit** (e.g. `stargate-module` cd57b97)
2. **Raw-fetch the relevant file** from that commit:
   ```bash
   curl -sL "https://raw.githubusercontent.com/OWNER/REPO/COMMIT/path/to/file.ts"
   ```
3. **Diff the working implementation against current code**
4. **Port the minimal proven fix**, not a speculative rewrite
5. **Verify the ported fix still works** (`npm run typecheck && npm run build`)

> **Pitfall:** Guessing the endpoint or auth pattern without checking the working branch wastes time. The legacy code already contains the correct URL, headers, and request shape.

## Pitfall: fetch() 301 Redirect Converts POST → GET

`fetch()` follows 301/302 redirects automatically, but **converts the method to GET** per spec. If the target endpoint only accepts POST, you get **405 Method Not Allowed**.

### Detection
- Network tab: `POST` → 301 → `GET` → 405
- Console: `Failed to load resource: the server responded with a status of 405 ()`

### Fix
Hardcode the final URL directly; never rely on a domain that 301-redirects:

```ts
// WRONG — api.ollama.com 301-redirects to ollama.com
const url = `${baseUrl}/v1/chat/completions`; // baseUrl = "https://api.ollama.com"

// CORRECT — bypass the redirect entirely
const url = "https://ollama.com/v1/chat/completions";
```

### Deep Fix: Scattered URL Rewrites in Large Codebases

When a project has accumulated "aggressive fixes" that rewrite URLs at multiple call sites, a single fix is not enough. You must find and update **all** locations.

**Search pattern:**
```bash
# Find every file that references the broken subdomain
grep -r "api\.ollama\.com" src/ electron/ --include="*.ts" --include="*.tsx" --include="*.js"
```

**Typical locations to check:**
1. `src/services/AIService.ts` — main API client (may have 3–5 rewrite sites)
2. `src/components/AIAgentsSettings.tsx` — model fetcher / settings save
3. `src/types/ai.ts` — `PROVIDER_INFO` defaults
4. `src/services/*Service.ts` — any service that builds API URLs
5. `electron/main.ts` — agent migration / sanitization logic
6. `electron/integrations/*/llm.ts` — background-process LLM callers
7. User config files — `~/.config/APP/ai-agents.json` (migrate saved agent URLs)

**Migration command for user configs:**
```bash
sed -i 's|"baseUrl": "https://api.ollama.com"|"baseUrl": "https://ollama.com"|g' \
  ~/.config/mosaic-companion/ai-agents.json
```

> **Pitfall:** Fixing only the main `AIService.ts` call site leaves 3–4 other rewrite sites still redirecting to the broken subdomain. Always do a codebase-wide grep.

## Provider-Specific Notes

### Ollama Cloud
- **Endpoint**: `https://ollama.com/v1/chat/completions` (OpenAI-compatible)
- **Never use**: `https://api.ollama.com` — returns 301 redirect that converts POST→GET, causing 405 Method Not Allowed
- **Auth**: Bearer token **required**; Cloudflare returns 405 without a valid key
- **Key location**: `ollama.com/settings/api-keys`
- **Client code**: treat as `provider === "ollama-cloud"` inside `sendToOpenAI()`; hardcode URL and validate `apiKey?.trim()` before request
- **Migration command** (when changing from old `api.ollama.com` to direct endpoint):
  ```bash
  sed -i 's|"baseUrl": "https://api.ollama.com"|"baseUrl": "https://ollama.com"|g' \
    ~/.config/mosaic-companion/ai-agents.json
  ```

### Generic OpenAI-Compatible
- Base URL should end at the host (e.g. `https://api.openai.com`)
- Path `/v1/chat/completions` is appended by the client
- Streaming: set `stream: true` and handle `ReadableStream` response body

## Checklist Before Claiming a Provider Works

- [ ] `npm run typecheck` passes
- [ ] `npm run build` produces a fresh renderer bundle
- [ ] `npm run build:electron` produces a fresh main process bundle (Electron apps require BOTH)
- [ ] **Full Electron app restart** (not just window reload) to load new bundles
- [ ] Network tab shows request hitting the **final** URL (no 301 in between)
- [ ] Request method remains `POST` all the way to the endpoint
- [ ] Response is JSON, not HTML (indicates wrong domain)
- [ ] `Test Connection` and real chat both succeed
- [ ] User config files migrated if they store provider URLs (e.g. `~/.config/APP/ai-agents.json`)

## References

- `references/ollama-cloud-endpoint.md` — Reproduction recipe for the 301 redirect trap
- `templates/openai-compatible-client.ts` — Minimal TypeScript client scaffold
