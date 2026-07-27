# Runbook: Stalled Ingestion

**Incident Type:** Indexer has stopped processing new ledgers  
**Severity:** HIGH — Users see stale data; new transactions don't appear in UI

---

## Detection

### Automatic Signals
- **Prometheus:** `indexer_stalled` gauge == 1
- **Prometheus:** `elcarehub_poller_stall_total{level="critical"}` rate > 0
- **Health endpoint:** `GET /readyz` returns 503 with `"stalled": true`
- **SSE:** Frontend receives `indexer-stalled` event with `stallDurationMs`

### Manual Check
```bash
# Check current sync state
curl http://localhost:4000/health/details \
  -H "Authorization: Bearer $HEALTH_DETAILS_TOKEN"

# Expected healthy output includes:
# "checks": { "sync_lag": { "status": "ok", "lagLedgers": <10 } }

# Check last indexed ledger advancement
curl http://localhost:4000/metrics | grep indexer_latest_ledger_processed
# Should increment every ~5 seconds (POLL_INTERVAL_MS)

# Check indexer logs
docker compose logs --tail=100 indexer | grep -iE 'stall|warn|error'
```

---

## Containment

### Immediate Actions

**DO:**
- ✅ Check Stellar RPC availability immediately
- ✅ Verify database and Redis connectivity
- ✅ Monitor frontend — users can still view cached data
- ✅ Check Prometheus `consecutiveRpcFailures` metric

**DO NOT:**
- ❌ Restart the indexer immediately without diagnosis — may mask root cause
- ❌ Manually modify `SyncState` lastLedger without understanding gap implications
- ❌ Delete MarketplaceEvent rows — causes data loss

### User Communication Template

```
[Status Page Update]
The ElcareHub indexer is experiencing sync delays. 
New listings and bids may not appear immediately. 
Existing listings are safe; no funds at risk. 
We are investigating and will update in 15 minutes.
```

---

## Diagnosis Decision Tree

```
                [ Stalled Ingestion Detected ]
                            │
                            ▼
                Check Indexer Logs for Root Cause
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
[ RPC Failures ]    [ DB Connection ]    [ Re-org Loop ]
       │                    │                    │
       ▼                    ▼                    ▼
See Section A       See Section B        See Section C
```

---

## A. RPC Failures

### Symptoms
- Logs show: `Error fetching events: ECONNREFUSED`, `429 Rate Limit`, `timeout`
- Metric: `consecutiveRpcFailures` >= 5

### Root Causes
| Cause | Diagnostic | Fix |
|---|---|---|
| RPC node down | `curl -X POST $STELLAR_RPC_URL -d '{"jsonrpc":"2.0","method":"getHealth","id":1}'` fails | Switch to fallback RPC; update `STELLAR_RPC_URL` |
| Rate limiting | Logs show `429` | Increase `POLL_INTERVAL_MS` from 5000 to 10000 |
| Network partition | Can reach RPC from host but not from container | Check Docker network config; restart Docker daemon |

### Recovery Steps

```bash
# 1. Test RPC connectivity from host
curl -s -X POST $STELLAR_RPC_URL \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
  | jq

# Expected: {"jsonrpc":"2.0","id":1,"result":{"status":"healthy"}}

# 2. If RPC is down, switch to fallback (testnet example)
export STELLAR_RPC_URL=https://soroban-testnet.stellar.org

# 3. Update indexer .env
sed -i 's|^STELLAR_RPC_URL=.*|STELLAR_RPC_URL=https://soroban-testnet.stellar.org|' indexer/.env

# 4. Restart indexer
docker compose restart indexer

# 5. Verify recovery within 30 seconds
watch -n 5 'curl -s http://localhost:4000/metrics | grep indexer_latest_ledger_processed'
```

**Verification:**  
Within 2 poll cycles (~10s), `indexer_latest_ledger_processed` should increment and `indexer_stalled` gauge should drop to 0.

---

## B. Database Connection Issues

### Symptoms
- Logs show: `Error: Connection terminated`, `P1001: Can't reach database`, `Pool timeout`
- Metric: `indexer_stalled` == 1, but `consecutiveRpcFailures` == 0

### Root Causes
| Cause | Diagnostic | Fix |
|---|---|---|
| PostgreSQL down | `docker compose ps db` shows `Exit 1` | `docker compose up -d db` |
| Pool exhausted | Logs: `Timed out fetching a connection from the pool` | Increase `DB_WRITE_CONNECTION_LIMIT` from 3 to 5 |
| Long-running query | Check `pg_stat_activity` for active queries > 30s | Kill blocking query; review `DB_STATEMENT_TIMEOUT` |

### Recovery Steps

```bash
# 1. Check database container status
docker compose ps db
# Expected: "Up" with health check passing

# 2. If down, restart
docker compose up -d db
# Wait 10 seconds for health check

# 3. Test connection from host
psql "$DATABASE_URL" -c "SELECT 1"
# Expected: (1 row)

# 4. Check for blocking queries
psql "$DATABASE_URL" -c "
SELECT pid, usename, state, query_start, state_change, query
FROM pg_stat_activity
WHERE state != 'idle' AND query_start < NOW() - INTERVAL '30 seconds'
ORDER BY query_start;
"

# 5. If pool exhaustion detected, increase limits
# Edit indexer/.env:
# DB_WRITE_CONNECTION_LIMIT=5
# Then restart:
docker compose restart indexer

# 6. Verify recovery
curl http://localhost:4000/health | jq '.checks.database'
# Expected: {"status": "ok", "latencyMs": <100}
```

**Verification:**  
`GET /health` returns 200; `sync_lag.status` is "ok" within 30 seconds.

---

## C. Re-org Loop

### Symptoms
- Logs show: `Re-org detected at ledger X`, `Rolling back events from ledger Y to Z`, repeated every few seconds
- Metric: `indexer_sync_latency_ledgers` oscillates instead of converging to 0

### Root Causes
| Cause | Diagnostic | Fix |
|---|---|---|
| Deep reorg (> MAX_ROLLBACK_DEPTH) | Check `_pollerHalted` in logs | Manual recovery via `POST /admin/reorg-recovery` |
| Wrong network RPC | `STELLAR_NETWORK_PASSPHRASE` mismatch | Verify passphrase matches RPC network |
| Corrupted SyncState | `lastLedgerHash` doesn't exist on network | Reset to safe ledger (see below) |

### Recovery Steps (Shallow Reorg)

Wait 2-3 poll cycles. The indexer auto-recovers from reorgs ≤ 100 ledgers depth.

```bash
# Monitor logs for rollback completion
docker compose logs -f indexer | grep -iE 'rollback|reorg'

# Expected pattern:
# [info] Re-org detected at ledger 145020
# [info] Rolling back events from ledger 145015 to 145020
# [info] Rollback complete. Resuming from safe ledger 145014
# [info] Processed ledger window [145015, 145030]
```

### Recovery Steps (Deep Reorg — Poller Halted)

```bash
# 1. Confirm halt state
curl http://localhost:4000/health/details \
  -H "Authorization: Bearer $HEALTH_DETAILS_TOKEN" \
  | jq '.pollerStatus'
# Expected: {"running": false, "halted": true, "reason": "deep_reorg"}

# 2. Identify safe rollback point
# Check Stellar network for ledger hash at depth 50
stellar rpc --rpc-url $STELLAR_RPC_URL getLedger --sequence <currentTip - 50>

# 3. Execute admin recovery (resets poller to safe ledger)
curl -X POST http://localhost:4000/admin/reorg-recovery \
  -H "Authorization: Bearer $HEALTH_DETAILS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "targetLedger": <safeLedger>,
    "targetHash": "<ledgerHash>",
    "reason": "deep_reorg_operator_recovery"
  }'

# Expected: {"success": true, "pollerRestarted": true, "rolledBackTo": <safeLedger>}

# 4. Verify poller resumed
watch -n 2 'curl -s http://localhost:4000/metrics | grep indexer_latest_ledger_processed'
```

**Verification:**  
Ledger counter advances steadily; no further rollback messages in logs.

---

## Data Integrity Verification

After recovery, confirm indexed state matches on-chain state:

```bash
# 1. Pick a recent listing ID from the frontend
LISTING_ID=12345

# 2. Query indexer
curl http://localhost:4000/listings/$LISTING_ID | jq '.status'
# Note the status (e.g., "Active")

# 3. Query on-chain state directly
stellar contract invoke \
  --id $MARKETPLACE_CONTRACT_ID \
  --rpc-url $STELLAR_RPC_URL \
  -- get_listing \
  --listing_id $LISTING_ID \
  | jq '.status'

# Expected: Statuses match

# 4. Spot-check 5 recent events in MarketplaceEvent table vs on-chain logs
# (Run reconciler for full sweep)
cd indexer
npm run reconcile:dry-run
```

---

## Communication Timeline

| Time Since Detection | Action |
|---|---|
| **T+0** | Post initial status: "Investigating sync delays" |
| **T+5m** | Identify root cause; post update with ETA |
| **T+15m** | Execute recovery steps |
| **T+20m** | Verify recovery; post "Incident resolved" |
| **T+2h** | Publish incident report with root cause and prevention measures |

---

## Prevention

### Monitoring
- **Alert:** Prometheus alert on `indexer_stalled == 1` for > 2 minutes
- **Alert:** `elcarehub_poller_stall_total{level="critical"}` rate > 0.01/sec
- **Alert:** `sync_lag_ledgers > 100` for > 5 minutes

### Configuration Hardening
```bash
# Increase RPC timeout for flaky networks
STELLAR_RPC_REQUEST_TIMEOUT_MS=10000

# Increase poll interval under rate limiting
POLL_INTERVAL_MS=7000

# Enable gap repair worker for unattended recovery from RPC window skips
GAP_REPAIR_ENABLED=true
ARCHIVAL_STELLAR_RPC_URL=https://mainnet.sorobanrpc.com
```

### Fallback RPC Configuration

Add multiple RPC endpoints in `.env`:

```bash
# Primary
STELLAR_RPC_URL=https://soroban-testnet.stellar.org

# Fallback (requires code change to support round-robin)
# For now, document manual switch procedure
```

---

## Rollback Constraints

**CANNOT ROLLBACK:**
- Events older than the oldest `LedgerCheckpoint` with status `committed` — they are immutable once checkpoint is committed
- Events already promoted to `confirmed=true` — frontend may have displayed them

**CAN ROLLBACK:**
- Events with `confirmed=false` (within `CONFIRMATION_DEPTH` ledgers of tip)
- `SyncState` cursor to any ledger >= earliest `LedgerCheckpoint.windowStart`

---

## Post-Incident Review Template

```markdown
## Incident: Stalled Ingestion — [Date]

**Duration:** [Detection time] to [Resolution time]
**Root Cause:** [RPC failure | DB pool exhaustion | Deep reorg]
**Impact:** Indexer fell [X] ledgers behind; frontend showed stale data for [Y] minutes

**Timeline:**
- T+0: Alert fired (indexer_stalled gauge)
- T+3m: Operator identified [root cause]
- T+10m: Applied fix [specific action]
- T+15m: Verified recovery; sync lag returned to < 10 ledgers

**Action Items:**
- [ ] Implement fallback RPC auto-switching (Issue #XXX)
- [ ] Increase DB connection pool to 5 (done)
- [ ] Add pre-emptive alert on `consecutiveRpcFailures >= 3` (Issue #YYY)
```

---

## Owner & Contacts

| Role | Contact | Escalation |
|---|---|---|
| **Primary:** DevOps Engineer | ops@elcarehub.xyz | Slack #alerts |
| **Secondary:** Backend Lead | backend-lead@elcarehub.xyz | Phone (urgent) |
| **Escalation:** CTO | cto@elcarehub.xyz | After 30min unresolved |

---

## Dashboard Links

- **Grafana:** https://grafana.elcarehub.xyz/d/indexer-health
- **Prometheus:** https://prometheus.elcarehub.xyz/graph?g0.expr=indexer_stalled
- **Logs:** Kubernetes logs or `docker compose logs -f indexer`

---

## Related Runbooks

- [Re-org Recovery](./reorganization.md)
- [Database Outage](./database-outage.md)
- [Keeper Failures](./keeper-failures.md)
