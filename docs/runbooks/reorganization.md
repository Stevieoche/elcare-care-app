# Runbook: Chain Reorganization

**Incident Type:** Stellar ledger reorg detected; indexer rolled back events  
**Severity:** MEDIUM for shallow (< 10 ledgers) / HIGH for deep (> 100 ledgers)

---

## Detection

### Automatic Signals
- Logs: `Re-org detected at ledger X. Stored hash [Y] does not match network hash [Z]`
- Logs: `Rolling back events from ledger A to B`
- Prometheus: `indexer_open_ledger_gaps{source="reorg"}` > 0
- Prometheus: `indexer_stalled` gauge == 1 (deep reorg halts the poller)
- Health: `GET /readyz` returns 503 after `REORG_HALT_ON_DEEP=true` trigger

### Operator Diagnostic
```bash
# Check for active reorg signals in logs
docker compose logs --tail=200 indexer | grep -iE 'reorg|mismatch|rollback|hash'

# Query database for LedgerGap rows created by reorg
psql "$DATABASE_URL" -c "
  SELECT id, \"fromLedger\", \"toLedger\", source, status, \"createdAt\"
  FROM \"LedgerGap\"
  WHERE source = 'reorg'
  ORDER BY \"createdAt\" DESC
  LIMIT 20;
"

# Check whether poller is halted
curl http://localhost:4000/health/details \
  -H "Authorization: Bearer $HEALTH_DETAILS_TOKEN"
```

---

## Classifying the Reorg

| Depth | Auto-Recovery | Operator Action |
|---|---|---|
| 1–10 ledgers | ✅ Automatic | Monitor only |
| 11–100 ledgers | ✅ Automatic, may take extra cycles | Verify `LedgerGap` repaired |
| > 100 ledgers | ❌ Poller halts (`REORG_HALT_ON_DEEP=true`) | Manual recovery — see Section B |

---

## A. Shallow Reorg (1–100 Ledgers)

### Containment

**DO:**
- ✅ Allow auto-recovery to complete (typically resolves in < 60 seconds)
- ✅ Watch logs for `Rollback complete. Resuming from safe ledger X`
- ✅ Monitor `indexer_open_ledger_gaps` gauge — should return to 0

**DO NOT:**
- ❌ Restart the indexer mid-rollback — risks partial rollback
- ❌ Delete database rows while the poller is running

### Monitoring Auto-Recovery
```bash
# Watch rollback progress
docker compose logs -f indexer | grep -E 'reorg|rollback|resuming'

# Expected log sequence:
# [warn] Re-org detected at ledger 145020
# [info] Rolling back events from ledger 145015 to 145020
# [info] Rollback complete. Resuming ingestion from safe ledger 145014
# [info] Processed ledger window [145015, 145025] — 3 events ingested
```

### Verify No Data Loss
```bash
# Confirm gap row moved to "Repaired" (if gap-repair is enabled)
psql "$DATABASE_URL" -c "
  SELECT status, COUNT(*) FROM \"LedgerGap\"
  WHERE source = 'reorg' GROUP BY status;
"
# Expected: All rows show "Repaired"

# Check MarketplaceEvent for gaps in ledger sequence
psql "$DATABASE_URL" -c "
  SELECT \"ledgerSequence\", COUNT(*) as events
  FROM \"MarketplaceEvent\"
  WHERE \"ledgerSequence\" > (
    SELECT MAX(\"lastLedger\") - 200 FROM \"SyncState\"
  )
  GROUP BY \"ledgerSequence\"
  ORDER BY \"ledgerSequence\";
"
```

**Verification:** `indexer_open_ledger_gaps` = 0; no further reorg messages in logs.

---

## B. Deep Reorg (> 100 Ledgers — Poller Halted)

### Containment and User Impact Assessment

**Data safety:** Events beyond the reorg point are provisional (`confirmed=false`) and will be rolled back. Users who received confirmed sale notifications may need to be re-notified. Funds in escrow remain safe — smart contract state is the source of truth.

**Safe actions:**
- ✅ Pause the smart contract to prevent new transactions during recovery
- ✅ Notify users that the marketplace is in maintenance mode
- ✅ Preserve current database state for audit (before rollback)

```bash
# Pause the contract while investigating (optional, precautionary)
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" \
  -- admin_pause \
  --admin "$ADMIN_PUBLIC"
```

### Recovery Steps

**Step 1: Identify the fork point**
```bash
# Find the last ledger where indexer hash matches network hash
# Start from current SyncState lastLedger and walk back
CURRENT_LEDGER=$(psql "$DATABASE_URL" -tAc "SELECT \"lastLedger\" FROM \"SyncState\" WHERE id = 1")

# Test ledgers walking backwards
for LEDGER in $(seq $CURRENT_LEDGER -1 $((CURRENT_LEDGER - 200))); do
  STORED_HASH=$(psql "$DATABASE_URL" -tAc "
    SELECT \"ledgerHash\" FROM \"LedgerCheckpoint\"
    WHERE \"windowEnd\" = $LEDGER AND status = 'committed'
    LIMIT 1
  ")
  NETWORK_HASH=$(stellar rpc --rpc-url $STELLAR_RPC_URL getLedger --sequence $LEDGER | jq -r '.hash')
  if [ "$STORED_HASH" = "$NETWORK_HASH" ]; then
    echo "Safe checkpoint found at ledger $LEDGER"
    SAFE_LEDGER=$LEDGER
    SAFE_HASH=$NETWORK_HASH
    break
  fi
done
```

**Step 2: Backup and rollback database**
```bash
# Create snapshot BEFORE rollback (for audit)
pg_dump "$DATABASE_URL" -f "/tmp/pre-reorg-rollback-$(date +%Y%m%d-%H%M%S).sql"

# Rollback events and state beyond safe point
psql "$DATABASE_URL" -c "
BEGIN;

-- Hard-delete unconfirmed events past the safe ledger
DELETE FROM \"MarketplaceEvent\"
WHERE \"ledgerSequence\" > $SAFE_LEDGER
  AND confirmed = false;

-- Reset listings/auctions/offers if their updatedAtLedger is beyond safe point
-- (Only status changes — do NOT delete user-created records)
-- Verify each change manually before committing

-- Update SyncState cursor
UPDATE \"SyncState\"
SET \"lastLedger\" = $SAFE_LEDGER,
    \"lastLedgerHash\" = '$SAFE_HASH',
    \"updatedAt\" = NOW()
WHERE id = 1;

-- Update TrackedContract cursors
UPDATE \"TrackedContract\"
SET \"lastLedger\" = $SAFE_LEDGER,
    \"lastLedgerHash\" = '$SAFE_HASH',
    \"updatedAt\" = NOW()
WHERE \"lastLedger\" > $SAFE_LEDGER;

-- Mark checkpoints beyond safe point as failed
UPDATE \"LedgerCheckpoint\"
SET status = 'failed', error = 'deep_reorg_rollback'
WHERE \"windowEnd\" > $SAFE_LEDGER;

COMMIT;
"
```

**Step 3: Trigger admin recovery via API**
```bash
curl -X POST http://localhost:4000/admin/reorg-recovery \
  -H "Authorization: Bearer $HEALTH_DETAILS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"targetLedger\": $SAFE_LEDGER,
    \"targetHash\": \"$SAFE_HASH\",
    \"reason\": \"deep_reorg_operator_recovery_$(date +%Y%m%d)\"
  }"
```

**Step 4: Re-index affected ledger range**
```bash
# If GAP_REPAIR_ENABLED=true, the gap worker handles this automatically
# Otherwise, run manual backfill
cd indexer
npm run backfill -- \
  --start=$SAFE_LEDGER \
  --end=$(stellar rpc --rpc-url $STELLAR_RPC_URL getLatestLedger | jq '.sequence') \
  --rpc=$STELLAR_RPC_URL
```

**Step 5: Unpause and verify**
```bash
# Only unpause after confirming sync state is healthy
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" \
  -- admin_unpause \
  --admin "$ADMIN_PUBLIC"

# Verify readiness
curl http://localhost:4000/readyz
# Expected: 200 {"ready": true}
```

---

## Distinguishing Stale vs Reverted Data

| Data State | Description | User Visibility |
|---|---|---|
| **Confirmed** | `confirmed=true`, ledger depth >= `CONFIRMATION_DEPTH` | Shown normally |
| **Provisional** | `confirmed=false`, within confirmation window | Shown with "pending" label |
| **Reverted** | Deleted post-reorg | No longer shown |

To determine whether data is stale vs missing vs reverted:

```bash
# Is the listing visible to the indexer at all?
psql "$DATABASE_URL" -c "
  SELECT l.\"listingId\", l.status, l.\"updatedAtLedger\",
         me.\"ledgerSequence\", me.confirmed, me.\"eventType\"
  FROM \"Listing\" l
  LEFT JOIN \"MarketplaceEvent\" me ON me.\"listingId\" = l.\"listingId\"
  WHERE l.\"listingId\" = $LISTING_ID
  ORDER BY me.\"ledgerSequence\" DESC;
"

# Cross-check with on-chain state
stellar contract invoke \
  --id $MARKETPLACE_CONTRACT_ID \
  --rpc-url $STELLAR_RPC_URL \
  -- get_listing \
  --listing_id $LISTING_ID
```

---

## Communication

### During Recovery
```
[Status Page Update]
ElcareHub is undergoing maintenance due to a Stellar network reorganization.
No user funds are at risk. The marketplace is temporarily paused to ensure
data consistency. We expect to restore service within 30-60 minutes.
```

### After Recovery
```
[Status Page Update]
Service has been restored. All data is synchronized with the Stellar network.
If you submitted a transaction during the maintenance window, please verify its
status in your wallet. Contact support@elcarehub.xyz if you see discrepancies.
```

---

## Prohibited Actions During Recovery

- ❌ **Do not run `migrate`** or apply database schema changes during reorg recovery
- ❌ **Do not delete confirmed events** (confirmed=true) — they represent valid historical state
- ❌ **Do not restart the indexer without completing the cursor reset** — will replay from wrong state
- ❌ **Do not update SyncState.lastLedger forward** — only backward to safe checkpoint

---

## Post-Incident Review Template

```markdown
## Incident: Chain Reorg — [Date]

**Depth:** [N] ledgers  
**Duration:** [start] to [resolution]
**Affected items:** [X] events rolled back, [Y] listings/auctions affected

**Timeline:**
- T+0: Re-org detected at ledger N
- T+Xm: Depth confirmed as [shallow/deep]
- T+Ym: Safe checkpoint identified at ledger M
- T+Zm: Database rolled back; poller restarted

**User Impact:** [N] users may have seen provisional data that was reverted

**Action Items:**
- [ ] Notify affected users of any confirmed transactions that changed status
- [ ] Enable gap-repair worker (GAP_REPAIR_ENABLED=true)
- [ ] Consider reducing CONFIRMATION_DEPTH from 10 to lower value
```

---

## Owner & Contacts

| Role | Contact | Escalation |
|---|---|---|
| **Primary:** Backend Lead | backend-lead@elcarehub.xyz | Slack #incidents |
| **Secondary:** DevOps | ops@elcarehub.xyz | Phone (urgent) |
| **Escalation:** CTO | cto@elcarehub.xyz | After 60min unresolved |

---

## Related Runbooks

- [Stalled Ingestion](./stalled-ingestion.md)
- [Database Outage](./database-outage.md)
