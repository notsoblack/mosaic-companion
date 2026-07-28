---
name: battery-validator-mesh
description: |
  BatteryAGI validator fleet mesh operations — multi-node CometBFT consensus
  across Tailscale tailnets, Genesis Ceremony participation, HyperAiBox
  configuration, and persistent-peers management.
triggers:
  - "batteryagi validator"
  - "genesis ceremony"
  - "cometbft"
  - "validator mesh"
  - "persistent peers"
  - "tailscale validator"
  - "hyperaibox docker"
  - "cross-tailnet"
---

# Battery Validator Mesh

Operations for the BatteryAGI five-node (or N-node) CometBFT validator mesh
running on HyperAiBox ARM64 nodes. Covers Tailscale networking quirks,
Genesis Ceremony workflow, HyperAiBox disk/Docker configuration, and
persistent-peers management.

## 1. Tailscale Cross-Tailnet IP Resolution

**Critical insight:** when a Tailscale node is shared TO another tailnet,
the recipient sees a **different 100.x IP** than the owner sees on their own
tailnet. This is the #1 root cause of "IP typo" misdiagnoses in multi-operator
validator fleets.

| Box | Owner's `tailscale status` self-IP | Fleet canonical (shared alias) |
|-----|-----------------------------------|-------------------------------|
| C-3PO | `100.92.116.49` | `100.92.116.48` |
| R2-D2 | `100.94.115.120` | `100.94.115.119` |

- The **owner** sees their self-IP (e.g. `.49`).
- **Other tailnets** that the node is shared TO see a different alias (e.g. `.48`).
- For `persistent_peers`, use the **fleet canonical IP** — the address the OTHER
  nodes will dial.
- Never assume a single IP is correct across all tailnets. Always ask:
  "What IP does YOUR tailnet see for this node?"

### How to verify
```bash
# On the owner's box — shows self-IP
tailscale status --json | jq -r '.Self.TailscaleIPs[]'

# On a peer box in a different tailnet — shows the shared alias
tailscale status --json | jq -r '.Peer[] | select(.HostName=="c3po") | .TailscaleIPs[]'
```

## 2. Genesis Ceremony Workflow

The BatteryAGI Genesis Ceremony is a multi-step coordinated process. Each
operator runs Step 1 locally; Harris (coordinator) runs Step 2; then all
operators run Step 3 and start on "GO."

### Step 1 — On Each Box (Operator)
```bash
# Download package (private repo — requires GitHub token)
export GITHUB_TOKEN="ghp_..."
curl -fsSL -L -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/octet-stream" \
  -o genesis-ceremony-package-20260722.tar.gz \
  "https://api.github.com/repos/Battery-Movement/batteryagi-validator-install/releases/assets/{ASSET_ID}"

# Verify SHA-256
echo "<sha256>  genesis-ceremony-package-20260722.tar.gz" | shasum -a 256 -c

# Extract and install
tar xzf genesis-ceremony-package-20260722.tar.gz
cd genesis-ceremony-package
./install.sh   # installs cometbft binary to /usr/local/bin or ~/.local/bin

# Run Step 1 — generates keys and public packet
./genesis-step1-box-init.sh <box-name> <moniker> <fleet-p2p-ip:26656>
```

**Security model:** `priv_validator_key.json` and `node_key.json` NEVER leave
the box. Only `packet-<box>.json` (public key + node ID) is shared.

**Golden rule:** after sending your packet, do NOT re-run Step 1 and do NOT
delete `~/.batterycoin-comet/`. A regenerated key invalidates genesis.

### Step 2 — Coordinator (Harris)
Collects all 5 `packet-*.json` files, assembles `genesis.json`, publishes SHA.

### Step 3 — On Each Box (Later, when coordinator sends bundle)

First, download the **genesis bundle** (a separate private release asset):

```bash
export GITHUB_TOKEN="ghp_..."

# List bundle asset IDs
curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/Battery-Movement/batteryagi-validator-install/releases/tags/genesis-ceremony-20260722" \
  | jq -r '.assets[] | select(.name | contains("bundle")) | "\(.name) → \(.id)"'

# Download using asset ID
curl -fsSL -L -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/octet-stream" \
  -o satoshi-returns-testnet-1-bundle.tar.gz \
  "https://api.github.com/repos/Battery-Movement/batteryagi-validator-install/releases/assets/{BUNDLE_ASSET_ID}"

# Verify bundle SHA-256 (given by coordinator)
echo "<bundle-sha256>  satoshi-returns-testnet-1-bundle.tar.gz" | shasum -a 256 -c

# Extract
tar xzf satoshi-returns-testnet-1-bundle.tar.gz
# → creates ./bundle/ with genesis.json, genesis.sha256, manifest.json, persistent_peers.txt

# Verify genesis SHA inside bundle
sha256sum bundle/genesis.json
cat bundle/genesis.sha256
```

Then run Step 3:

```bash
cd ~/genesis-ceremony-package
./genesis-step3-box-join.sh ~/bundle
```

Verifies SHA, installs genesis, sets persistent_peers (auto-removing self), opens RPC on `0.0.0.0:26657`. Does NOT start the node yet.

Reply **JOIN-OK <box>** in the chat.

### GO — Coordinated Start

When all five report JOIN-OK, coordinator calls **GO**. Each operator:

```bash
# 1. Stop old scaffold (frees ports 26656/26657)
docker stop batteryagi-validator
# If 'docker stop' hangs on a slow ARM64 box, use 'docker kill' as fallback

# 2. Start native CometBFT (runs outside Docker)
nohup cometbft node --home ~/.batterycoin-comet --proxy_app=kvstore > /tmp/cometbft.log 2>&1 &
# Alternative for persistence across SSH disconnect:
# tmux new-session -d -s cometbft 'cometbft node --home ~/.batterycoin-comet --proxy_app=kvstore'
```

**Port conflict warning:** the old `batteryagi-validator` Docker container binds `0.0.0.0:26656-26657`. If it is not fully stopped before starting native CometBFT, the new process will fail to bind. Verify the container is gone:
```bash
docker ps | grep batteryagi   # should be empty
ss -tlnp | grep 26656        # should show cometbft, not docker-proxy
```

Verify (run after ~30 seconds for consensus to warm up):
```bash
curl -s localhost:26657/status  | jq '.result.node_info.network, .result.sync_info.latest_block_height'
curl -s localhost:26657/net_info | jq '.result.n_peers'   # expect 4 for 5-node mesh
```

**Peer count reality check:** if some validators are on cross-tailnet IPs that don't route, you may see `n_peers=2` or `3` instead of `4`. This is OK if:
- Block height is climbing (not stuck at 0/1)
- The connected peers include at least one relay node (e.g. Mike or Maia)
- The missing peers are known to be on different tailnets with IP mismatches

Reply **UP <box>** when height is climbing. Report peer gaps only if height is stuck.

## 3. HyperAiBox Disk / Docker Configuration

**Common misconfiguration:** Docker `data-root` on `/userdata/docker`
(108GB overlay partition) instead of `/storage/docker-data` (1.9TB partition).

### Check current Docker root
```bash
cat /etc/docker/daemon.json
docker info --format '{{json .DockerRootDir}}'
```

### If data-root is on userdata (bad)
```bash
# Stop Docker
sudo systemctl stop docker

# Move data
sudo mkdir -p /storage/docker-data
sudo rsync -aP /userdata/docker/ /storage/docker-data/
sudo mv /userdata/docker /userdata/docker.old

# Update config
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "data-root": "/storage/docker-data",
  "dns": ["8.8.8.8", "1.1.1.1"],
  "ipv6": false
}
EOF

# Restart Docker
sudo systemctl start docker
```

## 4. Persistent Peers Management

When updating `.env` on a box, the peers must use IPs visible from THAT box's
tailnet — not the owner's tailnet.

```bash
# On C-3PO (mauricio240887@ tailnet)
# Can reach R2-D2 directly at 100.94.115.120
# But Hyperion (shared from AdgasHPEC@) may have a different alias
```

### Safe update pattern
```bash
# Backup first
cp .env .env.$(date +%Y%m%d-%H%M%S)

# Update persistent peers (comma-separated, no spaces)
sed -i 's/^BATTERYAGI_PERSISTENT_PEERS=.*/BATTERYAGI_PERSISTENT_PEERS=<ip1>:26656,<ip2>:26656,<ip3>:26656,<ip4>:26656/' .env

# Recreate container
docker compose -f compose.validator.yaml down && docker compose -f compose.validator.yaml up -d

# Verify peering
curl -s http://localhost:26657/net_info | jq '.result.n_peers'
```

## 5. Transferring Files to HyperAiBox Nodes

**SCP via Tailscale can timeout on large files.** If SCP fails:

1. Download directly on the box using `curl` with GitHub token (preferred)
2. Or relay through another box on the same LAN
3. Or use a temporary Python HTTP server on the LAN source

```bash
# On source box (C-3PO, same LAN as R2-D2)
python3 -m http.server 8765 --bind 192.168.0.150

# On target box (R2-D2)
curl -o file.tar.gz http://192.168.0.150:8765/file.tar.gz
```

## 6. Diagnostic: `catching_up: false` ≠ Synced

**Critical diagnostic pitfall:** When a validator is behind the live tip but reports `catching_up: false`, it means **fast-sync mode is OFF** — not that the node is caught up. The node may still be stuck.

| Condition | Interpretation | Action |
|-----------|---------------|--------|
| `height` climbing + `catching_up: false` | Normal consensus, synced | None |
| `height` stale for >2 min + `catching_up: false` | **Stuck** — not receiving blocks | Check peers, logs, ports |
| `height` climbing + `catching_up: true` | Fast-sync active | Wait |
| `height` = 0 or 1 + `catching_up: false` | Node never started consensus | Check port conflicts, genesis |

**Always check:** `latest_block_time` timestamp vs wall-clock. A node with `catching_up: false` but a block time >5 minutes old is stuck regardless of the flag.

```bash
# Correct diagnostic order
HEIGHT=$(curl -s http://localhost:26657/status | jq -r '.result.sync_info.latest_block_height')
TIME=$(curl -s http://localhost:26657/status | jq -r '.result.sync_info.latest_block_time')
CATCHING=$(curl -s http://localhost:26657/status | jq -r '.result.sync_info.catching_up')
PEERS=$(curl -s http://localhost:26657/net_info | jq -r '.result.n_peers')
echo "height=$HEIGHT time=$TIME catching_up=$CATCHING peers=$PEERS"
```

## 8. Controlled Maintenance Procedure (BatteryAGI 7-Step Protocol)

When a validator stalls (height stuck, `latest_block_time` stale, `catching_up: false` but not advancing), follow the BatteryAGI controlled maintenance procedure exactly. Do NOT delete data, re-run genesis, regenerate keys, or run `unsafe-reset-all` without coordinator approval.

### 8.1 The 7 Steps (in order, never skip)

1. **Capture diagnostics** — read-only, no action
2. **Stop only the stalled node** — preserve others
3. **Identify the unused large disk** — `lsblk`, `df`
4. **Safely free root-disk space** — present candidates first
5. **Move future CometBFT data to the large disk** — rsync + symlink
6. **Restart and inspect** — verify height advances
7. **If still stuck** — send first error, await coordinator approval

### 8.2 Step 1 — Capture diagnostics

```bash
NODE_HOME="$HOME/.batterycoin-comet"
EVIDENCE="$HOME/r2d2-maint-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE"
curl -s localhost:26657/status | tee "$EVIDENCE/status.json"
curl -s localhost:26657/net_info | tee "$EVIDENCE/net-info.json"
pgrep -af cometbft | tee "$EVIDENCE/processes.txt"
df -hT | tee "$EVIDENCE/disk-filesystems.txt"
lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT,UUID | tee "$EVIDENCE/block-devices.txt"
du -sh "$NODE_HOME" "$NODE_HOME/data" 2>/dev/null | tee "$EVIDENCE/comet-data-size.txt"
sudo du -xhd1 /var /home 2>/dev/null | sort -h | tee "$EVIDENCE/root-usage.txt"
docker system df 2>&1 | tee "$EVIDENCE/docker-usage.txt"
sudo journalctl --since "14 hours ago" --no-pager | grep -Ei 'comet|panic|error|no space|write|corrupt|i/o' | tee "$EVIDENCE/relevant-logs.txt"
tail -100 /tmp/cometbft.log | tee "$EVIDENCE/cometbft-log-last100.txt"
```

**Coordinator deliverables:** `relevant-logs.txt`, `root-usage.txt`, `block-devices.txt`, `docker-usage.txt`, and the last 100 lines of the CometBFT log.

### 8.3 Step 2 — Stop only the stalled node

```bash
NODE_HOME="$HOME/.batterycoin-comet"
sudo systemctl stop cometbft 2>/dev/null || pkill -TERM -f "cometbft node --home $NODE_HOME"
sleep 5
pgrep -af cometbft || echo "R2-D2 CometBFT stopped"
```

**SSH exit 255 after pkill:** When `pkill` via SSH returns exit 255, the process may still have been killed (pkill exits non-zero when it can't find the process). Verify with `pgrep`:
```bash
ssh hyperai@<ip> 'pgrep -f "cometbft node" || echo STOPPED'
```

**If `pkill`/`kill` via SSH is unreliable** (box is sluggish, process keeps respawning):
```bash
# Direct PID kill — most reliable on ARM64 boxes where pkill pattern-matching fails
ssh hyperai@<ip> 'sudo kill -9 $(pgrep -f "cometbft node" | head -1) 2>/dev/null; sleep 2; pgrep -f cometbft || echo STOPPED'
```

**When `pgrep` shows a PID but `kill -9 <PID>` via SSH returns "No such process":**
This happens when the process exits between `pgrep` and `kill` (race condition across two SSH round-trips). The process is already dead — verify with a single-command check:
```bash
ssh hyperai@<ip> 'ps aux | grep "cometbft node" | grep -v grep || echo STOPPED'
```
If this returns `STOPPED`, the process is gone regardless of earlier kill errors.

**Log path may vary:** Native CometBFT started via `nohup` may log to `~/r2d2-cometbft.log` (or whatever redirect path was used) rather than `/tmp/cometbft.log`. Always check `ls -la ~/*.log /tmp/*.log` to find the actual log.

**Verify other validators (C-3PO, Mike, Maia, Hyperion) continue advancing before any disk work.**

### 8.4 Step 3 — Identify the unused large disk

```bash
lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT,UUID
df -hT
```

**Do NOT run `mkfs`.** Determine:
- Which device contains unused capacity
- Whether it already has a filesystem
- Whether important data exists on it
- Its permanent mount point
- The storage should be ext4 or xfs, not a temporary USB/exFAT mount

**R2-D2 standard layout:** `/dev/sda1` (`1.9T`, `ext4`, `/storage`) — this is the confirmed target for validator data.

### 8.5 Step 4 — Safely free root-disk space

Present cleanup candidates, execute only safe ones:

```bash
sudo journalctl --disk-usage
sudo journalctl --vacuum-size=500M
sudo apt-get clean
docker image prune -f
# Remove orphaned Docker volumes
docker volume ls -f dangling=true
# Truncate MongoDB log if huge
sudo sh -c '> /var/log/mongodb/mongod.log'
df -hT /
```

**Do NOT delete:** Docker containers, volumes, unknown directories, or the CometBFT data directory. Target root disk below 85% with at least 10–15 GB free.

### 8.6 Step 5 — Move future CometBFT data to the large disk

```bash
BIG_MOUNT="/storage"
NODE_HOME="$HOME/.batterycoin-comet"
TARGET="$BIG_MOUNT/batteryagi/r2d2-comet-data"
df -hT "$BIG_MOUNT"
sudo mkdir -p "$TARGET"
sudo chown "$USER":"$USER" "$BIG_MOUNT/batteryagi" "$TARGET"
rsync -aH --info=progress2 "$NODE_HOME/data/" "$TARGET/"
mv "$NODE_HOME/data" "$NODE_HOME/data.rootdisk-backup"
ln -s "$TARGET" "$NODE_HOME/data"
ls -ld "$NODE_HOME/data"
du -sh "$TARGET"
```

**Keep `data.rootdisk-backup` until R2-D2 synchronizes successfully.** Never move or replace validator keys in `config/`.

### 8.7 Step 6 — Restart and inspect

```bash
nohup cometbft node --home "$HOME/.batterycoin-comet" --proxy_app=kvstore >"$HOME/r2d2-cometbft.log" 2>&1 &
```

**Expected behavior:**
- Height begins increasing beyond the stall point
- `catching_up` becomes `true` while replaying
- Peer count remains near four
- Disk usage remains stable

### 8.8 Step 7 — If it remains stuck

Stop and send the **exact first error** from the log. Do NOT wipe the data automatically. If the database is corrupted, a controlled fresh block replay preserving keys and state is needed — this requires coordinator approval because mishandling validator state creates double-signing risk.

---

## 9. Safe Disk Analysis (Never Prune Without Explicit Approval)

**User preference:** On live validator nodes, always present disk usage analysis first. Never run `docker system prune -a -f --volumes`, `rm -rf`, or any destructive cleanup without explicit user confirmation.

**User preference (conservative ops):** When a validator is actively catching up or producing blocks, do NOT restart, kill, or delete data files without explicit user approval. Even when diagnosing slow sync, the first action is read-only analysis (logs, configs, resources), not intervention.

**User preference (raw results):** When reporting diagnostics to the coordinator (BatteryAGI), present raw command output first, then interpretation. Do not summarize away details the coordinator may need.

### Analysis-first workflow

```bash
# 1. Identify large consumers (read-only, safe)
echo "=== data dir sizes ===" && du -sh ~/.batterycoin-comet/data/*
echo "=== docker storage ===" && docker system df
echo "=== journal disk usage ===" && sudo journalctl --disk-usage
echo "=== root usage ===" && df -h /
echo "=== large files in home ===" && find ~ -maxdepth 3 -type f -size +50M -exec ls -lh {} \; 2>/dev/null | sort -rh -k5 | head -10
```

### Typical cleanup candidates (present for approval)

| Candidate | Typical Size | Safety |
|-----------|-------------|--------|
| `~/.cache/*` | ~500MB–1GB | Usually safe (browser/build caches) |
| `~/.npm/*` | ~100–200MB | Safe if not actively building |
| Old inference AIM tarballs in `~/projects/` | ~300MB+ | Safe if already installed |
| Unused Docker images (not `batterycoin-node`) | ~400MB+ | Safe if identified correctly |
| Apt cache (`/var/cache/apt/archives`) | ~50MB | Safe |
| Journal logs older than configured retention | ~100–500MB | Usually safe |

**Forbidden without explicit user approval:**
- `docker system prune -a -f --volumes`
- `rm -rf ~/.batterycoin-comet/`
- `rm -rf ~/.local/`
- Any `kill -9` on `cometbft` or validator processes
- Any container or volume deletion
- Any restart of a validator that is actively producing or catching up blocks

## 8. UFW / Firewall P2P Port Blocking (Native CometBFT)

When running native CometBFT (outside Docker), the process binds directly to `0.0.0.0:26656`. If UFW or another host-level firewall is active, **port 26656 must be explicitly allowed for the Tailscale range** (`100.64.0.0/10`) or P2P connections will silently fail.

### Check UFW status
```bash
sudo ufw status
```

### Allow CometBFT P2P from Tailscale range
```bash
# Allow inbound P2P connections from any Tailscale IP
sudo ufw allow from 100.64.0.0/10 to any port 26656 proto tcp

# Verify
sudo ufw status | grep 26656
# Expected: 26656/tcp  ALLOW  100.64.0.0/10
```

**Why Docker worked before:** Docker bridge networking bypasses UFW by default. When switching to native CometBFT, UFW suddenly applies.

### Interface-specific rules (BatteryAGI recommended)

After initial GO, apply more precise interface-specific rules:

```bash
# On each box:
sudo ufw allow in on tailscale0 proto tcp to any port 26656 comment 'CometBFT P2P via Tailscale'
sudo ufw allow in on tailscale0 proto tcp to any port 26657 comment 'CometBFT RPC via Tailscale'
```

**These rules restrict CometBFT to the Tailscale interface only**, not globally. If `ufw allow 100.64.0.0/10` was already added during debugging, both sets of rules will coexist safely. The interface-specific rule is preferred for production; the range-based rule is a valid fallback during initial setup.

**Do NOT open 26656 globally** (`ufw allow 26656/tcp` from Anywhere) — this exposes validator P2P to the public internet.

**Pitfall:** `ufw allow 26656/tcp` (without `from`) only allows from Anywhere, which works but is overly permissive. The Tailnet-range rule is more precise.

### Asymmetric UFW discovery pattern

**Critical operational pitfall (discovered 2026-07-26 during `satoshi-returns-testnet-1` maintenance):** UFW rules can be **asymmetric** between two boxes. One box may allow inbound P2P while the other does not, causing unidirectional connectivity that appears as "missing peer" in CometBFT.

| Direction | Result | Root cause |
|-----------|--------|------------|
| C-3PO → R2-D2 | FAIL | C-3PO's UFW blocks outbound OR R2-D2's UFW blocks inbound |
| R2-D2 → C-3PO | SUCCEED | Reverse path is open |

**Always test BOTH directions with `nc -vz <peer-ip> 26656` from each box.** One direction working does NOT prove bidirectional peering works.

**Fix:** Add specific interface-based rules on BOTH boxes, even if only one direction fails:
```bash
# On C-3PO (even if C-3PO→R2-D2 fails, add rule allowing R2-D2 to reach C-3PO)
sudo ufw allow in on tailscale0 from 100.94.115.120 to any port 26656 proto tcp

# On R2-D2 (even if R2-D2→C-3PO succeeds, add rule allowing C-3PO to reach R2-D2)
sudo ufw allow in on tailscale0 from 100.92.116.49 to any port 26656 proto tcp
```

**Tailscale DERP vs direct routing indicator:**
- `tailscale ping` showing `via DERP(...)` with high latency (100–300ms) suggests asymmetric routing or firewall blocking direct path.
- `tailscale ping` showing `via <direct-ip>:<port>` with low latency (~30ms) confirms direct Tailscale path is open.
- If one direction shows DERP and the other shows direct, the DERP direction is likely blocked by UFW.

### SSH exit 255 + pkill pitfall

When stopping native CometBFT via SSH, `pkill -TERM -f cometbft` may return SSH exit 255 even when the process was successfully terminated. This happens because:
1. `pkill` exits with code 1 (no matching process found — because the signal killed it)
2. SSH propagates the non-zero exit as 255

**Always verify with `pgrep` after `pkill`:**
```bash
pkill -TERM -f cometbft; sleep 2; pgrep -f cometbft || echo "STOPPED"
```

If `pgrep` returns nothing, the process is stopped — ignore the SSH exit 255.

## 9. Fleet Canonical IPs vs Real Tailscale IPs in persistent_peers

**Critical new pitfall discovered during `satoshi-returns-testnet-1` launch (2026-07-24):**

The Genesis Ceremony bundle's `persistent_peers.txt` may contain **fleet canonical IPs** (shared aliases) like `100.92.116.48` and `100.94.115.119`. These are NOT real Tailscale IPs on the owner's tailnet — they are shared aliases from the coordinator's tailnet namespace.

| Box | Fleet canonical (bundle) | Owner's real Tailscale IP | Status |
|-----|-------------------------|---------------------------|--------|
| C-3PO | `100.92.116.48` | `100.92.116.49` | ❌ Unreachable from owner's tailnet |
| R2-D2 | `100.94.115.119` | `100.94.115.120` | ❌ Unreachable from owner's tailnet |

**Verification:**
```bash
# From R2-D2: fleet alias fails, real IP succeeds
ping -c 1 100.92.116.48   # FAIL
ping -c 1 100.92.116.49   # OK

# From C-3PO: fleet alias fails, real IP succeeds
ping -c 1 100.94.115.119  # FAIL
ping -c 1 100.94.115.120  # OK
```

**Fix after Step 3:** Update `persistent_peers` in `~/.batterycoin-comet/config/config.toml` to use the real direct Tailscale IPs (`.49` and `.120`) instead of fleet aliases (`.48` and `.119`):

```bash
# On R2-D2: replace C-3PO's fleet alias with real IP
sed -i 's/100\.92\.116\.48:26656/100.92.116.49:26656/g' ~/.batterycoin-comet/config/config.toml

# On C-3PO: replace R2-D2's fleet alias with real IP
sed -i 's/100\.94\.115\.119:26656/100.94.115.120:26656/g' ~/.batterycoin-comet/config/config.toml
```

Then restart CometBFT for the change to take effect.

**Always verify before accepting IPs:** `tailscale status` on the DIALER's machine is the source of truth, not the bundle.

## 10. Restarting Native CometBFT After Config Changes

Unlike Docker containers (which auto-restart), native CometBFT must be manually restarted after any `config.toml` change.

### Graceful restart (preserves log continuity)
```bash
# Option A: If running in tmux
tmux send-keys -t cometbft C-c
sleep 3
tmux new-session -d -s cometbft 'cometbft node --home ~/.batterycoin-comet --proxy_app=kvstore 2>&1 | tee /tmp/cometbft.log'

# Option B: Kill and restart
pkill -f 'cometbft node --home'
sleep 2
nohup cometbft node --home ~/.batterycoin-comet --proxy_app=kvstore > /tmp/cometbft.log 2>&1 &

# Verify
ss -tlnp | grep 26656   # should show cometbft
pgrep -af cometbft
```

**Wait 30–60 seconds after restart** before checking status — consensus needs time to reconnect to peers.

## 11. Gap Widening vs Slow Catch-Up — Diagnostic Distinction

| Pattern | `catching_up` | `latest_block_time` | Gap Trend | Interpretation |
|---------|--------------|--------------------|-----------|---------------|
| **Advancing, gap stable or closing** | `true` or `false` | Within 2 min of wall-clock | Narrowing or stable | Normal catch-up, wait |
| **Advancing, gap widening** | `true` | >5 min behind wall-clock | Growing | Live chain producing faster than replay; may need more peers or state sync |
| **Stuck** | `false` | >5 min stale | Flat | Not receiving blocks; check peers, UFW, persistent_peers IPs |

**Key rule:** Check `latest_block_time` against wall-clock, not just `catching_up` or height.

### Temporary gap widening during active catch-up

When `catching_up: true` first activates (e.g. after fixing persistent_peers and restarting), the gap may **temporarily widen** for 10–20 minutes. This is normal: the live chain continues producing blocks at full speed while the replay engine warms up. Replay rate typically accelerates as the node approaches the tip.

**Real example (R2-D2, 2026-07-24):**
- After persistent_peers fix + restart: gap ~800 blocks
- 5 min later: gap grew to ~1000 blocks (live chain produced faster)
- 20 min later: gap closed to ~300 blocks (replay accelerated)
- 35 min later: `catching_up: false`, fully synced

**Do not panic or restart during temporary widening.** Poll every 5 minutes; if gap consistently shrinks over 3+ polls, the node will reach the tip. Only consider state sync if gap grows for 30+ minutes AND `catching_up: true` persists.

## 12. Pre-Ceremony Checklist

Before running Genesis Step 1 on any box:

- [ ] Disk space: at least 5GB free on `/` (check with `df -h /`)
- [ ] Docker running and responsive
- [ ] Tailscale active (`tailscale status` shows `active`)
- [ ] Current validator config backed up (`.env`, `compose.validator.yaml`, `genesis/`)
- [ ] Box reachable via SSH (test both Tailscale IP and LAN IP)
- [ ] `cometbft` not yet installed, OR `FORCE=1` not needed (don't re-run Step 1)
- [ ] **UFW configured** (if using native CometBFT): `sudo ufw status | grep 26656` returns ALLOW

## 13. Symmetric / Asymmetric Box Offline Cycling

**Operational pattern discovered 2026-07-27:** When a validator fleet consists of boxes that are physically moved between networks (e.g. R2-D2 and C-3PO on the same physical LAN, one unplugged at a time), the offline state is **symmetric** — when one comes back, the other may go down.

**Sequence observed:**
1. R2-D2 goes offline (unreachable via all IPs)
2. User moves R2-D2 to a different network, plugs it back in
3. R2-D2 comes back online — SSH works, Tailscale active, CometBFT running
4. C-3PO is now offline (`offline, last seen 1m ago`)

**Root cause:** The user physically unplugged C-3PO to plug in R2-D2 (same power outlet, same network port, or same attention window). Both boxes cannot be online simultaneously in the user's current setup.

**Prevention / response:**
- When a user says "try again, I reconnected it," always check the FULL mesh immediately — not just the reconnected box
- The box that was online before may now be offline
- Report the full mesh status: which boxes are reachable, which are not
- Do not assume the previously offline box is the only one that needed fixing

### Reconnected box is 3+ hours behind the tip

When a box comes back after being offline for hours, its CometBFT process will still be running (if it was started via `nohup`). However, it will be **stuck at the old height** with `catching_up: false` and a stale `latest_block_time`. It will NOT automatically catch up.

**Why:** CometBFT's `catching_up` flag only becomes `true` after a restart when the node re-dials peers and discovers the new chain tip. A running process that was offline does not re-discover the tip on its own.

**Fix:** Restart the box's CometBFT process (one at a time, as BatteryAGI instructs):
```bash
# On the reconnected box
pkill -f 'cometbft node --home'
sleep 2
nohup cometbft node --home ~/.batterycoin-comet --proxy_app=kvstore > ~/r2d2-cometbft.log 2>&1 &
```

After restart, the node will:
1. Re-dial all persistent_peers
2. Discover the live chain tip
3. Set `catching_up: true`
4. Replay blocks at full speed (typically 50–300 blocks/sec on RK3588)

**Do NOT trust `catching_up: false` on a reconnected box.** Always check `latest_block_time` against wall-clock. If the block time is >5 minutes old, the node needs a restart to catch up.

**Symptom:** After restart, the node may temporarily report only 1–2 peers for the first 30–60 seconds while it establishes connections. The full mesh of 3–4 peers will appear once all persistent_peers connections succeed.

## 14. RPC Unresponsive During Fast Block Replay

When a validator restarts after being offline for hours, it replays blocks at maximum CPU speed (50–300 blocks/sec on RK3588). During this replay, the RPC endpoint (`curl localhost:26657/status`) may return empty responses, timeouts, or JSON parse errors. This is **normal** — the node is CPU-bound processing blocks.

**Workaround 1: Check log tail for height progress**
```bash
tail -5 ~/r2d2-cometbft.log | grep -E 'height|Finalized|Committed'
```

**Workaround 2: Use simple grep on raw RPC output (avoiding Python JSON parse)**
```bash
curl -s localhost:26657/status | grep -oE 'latest_block_height\":[0-9]+'
```

**Do NOT restart the node** because RPC is "not responding." The replay is healthy — just wait. RPC will become responsive once the node reaches the live tip and transitions to `catching_up: false`.

**How to know it's working:**
- Log shows `height=` climbing every few milliseconds
- Block time in log advances steadily
- After 2–5 minutes (for a 3-hour gap), the log will show `RoundStepNewHeight` and `Received proposal` — these mean the node has reached the live tip and is participating in consensus

## 15. Process Respawning After Kill — Parent/Manager Detection

If `pgrep` keeps finding a new PID after `kill`, the process is being managed by something else. Check in this order:

| Manager | Check command | Resolution |
|---------|--------------|------------|
| systemd | `sudo systemctl status cometbft` | `sudo systemctl disable cometbft; sudo systemctl stop cometbft` |
| tmux | `tmux ls` | `tmux kill-session -t cometbft` |
| nohup / ssh session | `ps -o pid,ppid,cmd -p <PID>` | If PPID = 1 (systemd), it's a detached nohup process — use `kill -9` |
| Docker container | `docker ps \| grep batteryagi` | `docker stop batteryagi-validator` |
| Cron / systemd user timer | `crontab -l` / `systemctl --user list-timers` | Disable the trigger |

## References

- `references/tailscale-ip-cross-tailnet.md` — Detailed IP map and verification commands
- `references/genesis-ceremony-commands.md` — Full command log for Steps 1–3
- `references/hyperaibox-docker-config.md` — Docker data-root migration recipe
- `references/native-cometbft-operations.md` — UFW, restart, log locations, persistent_peers live updates
- `references/session-satoshi-returns-go-20260724.md` — Complete GO execution, R2-D2 catch-up timeline, UFW application, disk cleanup raw results (2026-07-24)
- `references/session-r2d2-maintenance-20260726.md` — Controlled maintenance: stalled validator diagnosis, 7-step BatteryAGI protocol, data migration to /storage, successful restart and sync
- `references/asymmetric-ufw-missing-peer-20260726.md` — BatteryAGI instruction: confirm missing mutual peer, test bidirectional P2P, fix asymmetric UFW, restart one node at a time, achieve 4 peers each
- `references/offline-validator-reconnection.md` — When a box goes offline (SSH timeout, Tailscale ping fails) and the user reconnects it; full diagnostic sequence, peer mesh check, symmetric offline cycling pattern
- `references/session-r2d2-reconnection-20260727.md` — R2-D2 reconnected after 3h network outage: process still running but stuck at old height, required restart to re-discover live tip; RPC unresponsive during fast replay workaround; direct PID kill for unreliable pkill; asymmetric box offline cycling (C-3PO went offline when R2-D2 came back)

