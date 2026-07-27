# Runbook: Database Outage

**Incident Type:** PostgreSQL unavailable or severely degraded  
**Severity:** CRITICAL — Indexer stops ingesting; API returns 503; user data inaccessible

---

## Detection

### Automatic Signals
- **Health endpoint:** `GET /health` returns 503 with `"database": { "status": "down" }`
- **Prometheus:** `indexer_stalled` == 1 (writes fail, last progress timestamp goes stale)
- **Logs:** `P1001: Can't reach database server`, `Connection terminated unexpectedly`

### Manual Check
```bash
# Test API health
curl http://localhost:4000/health | jq '.checks.database'

# Test DB directly
docker compose ps db   # verify container status

psql "$DATABASE_URL" -c "SELECT 1"  # verify connectivity
```

---

## Containment

**DO:**
- ✅ The indexer will retry connections automatically; avoid repeated restarts
- ✅ Redis cache may still serve recent API responses to users
- ✅ Smart contracts operate independently — funds are safe; on-chain state is unaffected
- ✅ Notify users via status page if outage exceeds 5 minutes

**DO NOT:**
- ❌ Run database migrations (`prisma migrate deploy`) during an active outage
- ❌ Point `DATABASE_URL` at a read replica for writes — the indexer requires a primary
- ❌ Delete or truncate tables to "clear" the problem without understanding root cause
- ❌ Forcibly terminate the indexer process — let it retry; forced kill may leave a checkpoint in `applying` state

---

## A. Container / Process Failure

```bash
# Check container status
docker compose ps db

# Restart if stopped
docker compose up -d db

# Wait for health check (up to 30 seconds)
docker compose ps db

# Verify connection pool recovery
docker compose logs indexer | tail -20 | grep -iE 'database|prisma|connection'

# Expected: "Database connection re-established"
```

---

## B. Connection Pool Exhaustion

### Symptoms
- Logs: `Timed out fetching a connection from the pool`
- Metric: `http_request_duration_seconds{status="500"}` spikes
- `DB_HEALTH_WARN_THRESHOLD_MS` exceeded in logs

```bash
# Check pg_stat_activity for active connections
psql "$DATABASE_URL" -c "
  SELECT state, COUNT(*) as count
  FROM pg_stat_activity
  WHERE datname = current_database()
  GROUP BY state
  ORDER BY count DESC;
"

# Check for long-running queries blocking connections
psql "$DATABASE_URL" -c "
  SELECT pid, now() - pg_stat_activity.query_start AS duration,
         query, state
  FROM pg_stat_activity
  WHERE state != 'idle'
    AND (now() - pg_stat_activity.query_start) > interval '30 seconds'
  ORDER BY duration DESC;
"

# If blocking query found, terminate (ONLY if safe to do so)
# psql "$DATABASE_URL" -c "SELECT pg_terminate_backend(<pid>);"
```

**Tuning for pool exhaustion:**
```bash
# In indexer/.env, increase limits and restart:
DB_CONNECTION_LIMIT=15         # was 10
DB_WRITE_CONNECTION_LIMIT=5    # was 3
DB_POOL_TIMEOUT=45             # was 30

docker compose restart indexer
```

**Verification:** `pg_stat_activity` shows connection count drops below `POSTGRES_MAX_CONNECTIONS` (default 50).

---

## C. Disk Full

### Symptoms
- Logs: `FATAL: could not write to file`, `could not extend file`
- Docker or host shows disk at 100%

```bash
# Check Docker disk usage
docker system df

# Check host disk
df -h /var/lib/docker

# Check PostgreSQL data directory size
du -sh /var/lib/postgresql/data 2>/dev/null \
  || docker compose exec db du -sh /var/lib/postgresql/data
```

**Remediation:**
```bash
# 1. Free space first — remove old Docker images
docker image prune -f
docker volume prune -f  # ONLY unused volumes

# 2. Identify large tables
psql "$DATABASE_URL" -c "
  SELECT relname AS table,
         pg_size_pretty(pg_total_relation_size(relid)) AS total_size
  FROM pg_stat_user_tables
  ORDER BY pg_total_relation_size(relid) DESC
  LIMIT 10;
"

# 3. If MarketplaceEvent table is very large, archive old confirmed events
# (Only after consulting the data retention policy)
```

---

## D. Corrupt / Stuck Checkpoint (after partial write)

If the indexer crashed during a write, a `LedgerCheckpoint` may be stuck in `applying` state:

```bash
# Find stuck checkpoints
psql "$DATABASE_URL" -c "
  SELECT id, \"contractId\", \"windowStart\", \"windowEnd\", status, \"updatedAt\"
  FROM \"LedgerCheckpoint\"
  WHERE status IN ('applying', 'fetched')
  ORDER BY \"updatedAt\";
"
```

The indexer automatically replays these on restart (all event upserts are idempotent via `eventHash` unique constraint). If a checkpoint is > 30 minutes old in `applying` state with no progress:

```bash
# Reset stuck checkpoints (safe due to idempotent replays)
psql "$DATABASE_URL" -c "
  UPDATE \"LedgerCheckpoint\"
  SET status = 'fetched', error = 'reset_by_operator'
  WHERE status = 'applying'
    AND \"updatedAt\" < NOW() - INTERVAL '30 minutes';
"

# Restart indexer to trigger replay
docker compose restart indexer
```

---

## Determining Data Staleness

| Signal | Interpretation |
|---|---|
| `GET /readyz` returns 503 | DB down or sync stalled — data may be stale |
| `sync_lag.lagLedgers` > 100 | Data more than ~500 seconds behind |
| `SyncState.updatedAt` timestamp | Last time the DB was successfully written to |
| `MarketplaceEvent.ledgerSequence` max value | Last ledger recorded in the event log |

```bash
# When was the database last successfully written to?
psql "$DATABASE_URL" -c "
  SELECT \"lastLedger\", \"updatedAt\",
         EXTRACT(EPOCH FROM (NOW() - \"updatedAt\")) / 60 AS minutes_ago
  FROM \"SyncState\"
  WHERE id = 1;
"

# How many recent events are unconfirmed vs confirmed?
psql "$DATABASE_URL" -c "
  SELECT confirmed, COUNT(*) as events
  FROM \"MarketplaceEvent\"
  WHERE \"ledgerSequence\" > (
    SELECT MAX(\"lastLedger\") - 50 FROM \"SyncState\"
  )
  GROUP BY confirmed;
"
```

---

## User Communication

```
[Status Page — DB Outage]
ElcareHub is experiencing database connectivity issues.
New listings, bids, and marketplace activity may be delayed.
Your funds and assets on the Stellar blockchain are not affected.
We are working to restore full service. Next update in 15 minutes.
```

---

## Post-Recovery Checklist

```bash
# 1. Verify DB is healthy
curl http://localhost:4000/health | jq '.checks.database'
# Expected: {"status": "ok"}

# 2. Verify indexer resumes ingestion
watch -n 5 'curl -s http://localhost:4000/metrics | grep indexer_latest_ledger_processed'
# Ledger number should advance

# 3. Check for missed ledger gaps
psql "$DATABASE_URL" -c "SELECT * FROM \"LedgerGap\" WHERE status = 'Open';"

# 4. If gaps found, trigger repair
curl -X POST http://localhost:4000/admin/trigger-gap-repair \
  -H "Authorization: Bearer $HEALTH_DETAILS_TOKEN"

# 5. Verify dead-letter events (parse failures during recovery)
psql "$DATABASE_URL" -c "
  SELECT COUNT(*) FROM \"DeadLetterEvent\" WHERE status = 'Pending';
"
# If > 0, replay after root cause is fixed:
# cd indexer && npm run dead-letter-replay
```

---

## Prohibited Actions

- ❌ Do not run `DROP TABLE`, `TRUNCATE`, or delete indexes during recovery
- ❌ Do not change `DATABASE_URL` to a different database without migrating schema
- ❌ Do not apply Prisma migrations while an outage is active
- ❌ Do not restore from backup without stopping the indexer first

---

## Post-Incident Review Template

```markdown
## Incident: Database Outage — [Date]

**Duration:** [start] to [resolution]
**Root Cause:** [container crash | pool exhaustion | disk full | hardware]
**Impact:** API returned 503 for [N] minutes; indexer fell [X] ledgers behind

**Timeline:**
- T+0: /health reported database down
- T+Xm: Root cause identified ([cause])
- T+Ym: Remediation applied
- T+Zm: DB recovered; indexer resumed

**Action Items:**
- [ ] Set up database backup/restore runbook
- [ ] Enable managed PostgreSQL (Railway / RDS / Supabase) for HA
- [ ] Add disk usage alert at 80% capacity
- [ ] Review connection pool limits
```

---

## Owner & Contacts

| Role | Contact | Escalation |
|---|---|---|
| **Primary:** DevOps | ops@elcarehub.xyz | Slack #alerts |
| **Secondary:** Backend Lead | backend-lead@elcarehub.xyz | Phone (urgent) |

---

## Related Runbooks

- [Stalled Ingestion](./stalled-ingestion.md)
- [Redis Outage](./redis-outage.md)
