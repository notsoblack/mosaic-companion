---
name: midnight-ecosystem-evaluation
description: |
  Use when the user shares an external Midnight-related project, repository, website, or
  hackathon submission and asks for analysis, maturity assessment, integration feasibility,
  or pattern mapping against the local midnight-expert knowledge base. Covers ecosystem
  due diligence (distinguishing concept decks from shipping code), mapping project needs to
  existing Compact contract patterns, and producing structured collaboration recommendations.
version: 0.1.0
---

# Midnight Ecosystem Evaluation

## When to use this skill

- User drops a GitHub repo URL and asks "can we integrate this?"
- User shares a website (e.g. `*.vercel.app`) and asks if a feature is ready to use.
- User forwards a collaboration invitation and wants a technical readiness assessment.
- User wants to know which existing `midnight-expert` patterns map to an external project's needs.

## Evaluation Checklist

Run this checklist in order before making any integration claims.

| Step | Check | How to verify |
|------|-------|-------------|
| 1 | **Does the site/repo link to source code?** | Look for "GitHub", "Source", "Docs" links. If absent, treat as concept-only. |
| 2 | **Is there a live demo or interactive feature?** | Try to click through — wallet connect, form submission, proof generation. Mock UIs return after timeouts (~1–2s) with no network activity. |
| 3 | **Search GitHub for the project name.** | `github.com/search?q=<project-name>&type=repositories`. Note star count, last push date, and whether it matches the site. |
| 4 | **Check for package/SDK availability.** | Search npm, crates.io, or the repo for published packages. If none, integration must be hand-rolled. |
| 5 | **Identify conference vs. product origin.** | Look for banners like "LFDT-NIGHTSTREAM · MARCH 2026" — these are architecture proposals, not shipping products. |
| 6 | **Assess contract layer existence.** | A Midnight dApp without `.compact` files is frontend-only. Backend mock stubs must be built from scratch. |

## Pitfall: Concept Deck vs. Real Product

A polished website with layer diagrams and buzzwords is **not evidence** of a usable SDK.

**Red flags:**
- No repository link anywhere on the landing page.
- All interactive buttons are stubs (e.g., `setTimeout` mock wallet connect).
- No npm package, no CLI install command, no Docker image.
- Origin is a conference talk or hackathon concept deck.

**What to report to the user:**
> "The site is a **vision/architecture deck**, not a shipping SDK. The patterns described are buildable using existing Compact contracts, but there is no turnkey package to import."

## Pattern Mapping Guide

When an external project needs a credential system, map its requirements to the proven patterns in `midnight-expert`.

| Project Need | Local Pattern | File |
|--------------|---------------|------|
| Hide credential value on-chain | Commitment | `compact-core:compact-privacy-disclosure/examples/SelectiveDisclosure.compact` |
| Prove property without revealing value | Selective Disclosure | `verifyThreshold()` / `verifyRange()` in SelectiveDisclosure |
| Role-based issuance / revocation | Access Control | `compact-examples:.../access/AccessControl.compact` |
| Signed identity credential | Passport Identity | `compact-examples:.../midnight-rwa/PassportIdentity.compact` |
| Witness-derived authorization | RWA Pattern | `compact-examples:.../midnight-rwa/midnight-rwa.compact` + `witnesses.ts` |
| Revocation registry | Set<Bytes<32>> | Combine `AccessControl_revokeRole` with a `Set` ledger field |

### The Credential System Composition Recipe

Most Midnight hackathon projects that need "issue → prove → verify → revoke" can be built by composing three existing examples:

1. **`SelectiveDisclosure.compact`** — `persistentCommit<T>` for hidden credentials, `verifyThreshold()`/`verifyRange()` for ZK proofs.
2. **`AccessControl.compact`** — `grantRole`/`revokeRole` for sponsor authorization and revocation registry.
3. **`PassportIdentity.compact`** — `SignedCredential<T>` + `assertIdentity()` for issuer-signed credential verification.

**Adaptation steps:**
- Replace `PassportData` with the project's specific credential struct (e.g., `ClinicalTrialData`).
- Use `AccessControl` roles for "Sponsor" vs. "Verifier" authorization.
- Use `SelectiveDisclosure` circuits for the actual `issueCredential()` and `verifyParticipation()` logic.

## Recommended Output Format

When reporting back to the user, structure the analysis as:

1. **Project Overview** — what it claims to be.
2. **Maturity Table** — layer-by-layer status (✅/🚧/❌/🔴).
3. **Critical Gaps** — what's missing that blocks integration.
4. **Local Pattern Mapping** — which existing skills/examples solve each gap.
5. **Next Step Proposal** — concrete deliverable (e.g., draft `.compact` contract, SDK wiring guide, devnet deployment script).

## References

- `references/project-assessment-checklist.md` — condensed checklist for quick reuse.
- `references/credential-system-pattern-recipe.md` — step-by-step composition recipe with circuit snippets.