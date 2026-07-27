# Runbook: Redis Outage

**Incident Type:** Redis cache unavailable or degraded  
**Severity:** MEDIUM — API latency spikes; SSE replay fails; cache misses degrade UX

---

## Detection

### Automatic Signals
- **Health endpoint:** `GET /health` returns `"redis": { "status": "down" }` (overall status may still be `degraded`, not `down`, since Redis is non-critical)
- **Logs:** `Redis connection error: ECONNREFUSED`, `Redis client not connected`
- **Prometheus:** `http_request_duration_seconds` p95 increases (cache misses)

### Manual Check
```bash
# Check Redis health via API
curl http://localhost:4000/health | jq '.checks.redis'

# Check Redis container
docker compose ps redis

# Test Redis directly
redis-cli -u "$REDIS_URL" PING
# Expected: PONG
```

---

## Impact Assessment

| Feature | Redis Down | Fallback Behavior |
|---|---|---|
| API responses | Cache misses | Falls back to direct DB reads — slower but functional |
| SSE event stream | New events still broadcast | Replay buffer unavailable — reconnecting clients miss history |
| Rate limiting | Disabled | All requests pass through (minor risk) |
| Session/auth | Not used | No impact |

**User impact:** API responses are slower (DB read latency instead of Redis ~1ms). The marketplace remains functional but may appear sluggish under load.

**Funds safety:** Redis holds no financial state. All fund-relevant data is in PostgreSQL and Soroban contracts.

---

## Containment

**DO:**
- ✅ Allow the indexer to continue running with cache-miss fallback
- ✅ Monitor DB connection pool for increased load (cache misses add DB queries)
- ✅ Notify users only if latency is user-visible (> 2 seconds for listings page)

**DO NOT:**
- ❌ Restart the indexer because of Redis alone — it runs without Redis
- ❌ Increase `REDIS_CACHE_TTL_SECONDS` aggressively — stale data is worse than slow data
- ❌ Skip Redis cache invalidation logic when restoring — stale entries cause incorrect UI state

---

## A. Container Restart

```bash
# Check container logs for cause
docker compose logs redis | tail -50

# Restart Redis
docker compose restart redis

# Verify Redis is healthy
redis-cli -u "$REDIS_URL" PING
# Expected: PONG

# Wait for indexer to reconnect (happens automatically)
docker compose logs indexer | tail -20 | grep -i redis
# Expected: "Redis reconnected"

# Verify health endpoint recovers
curl http://localhost:4000/health | jq '.checks.redis'
```

---

## B. Memory Exhaustion (OOM)

### Symptoms
- Redis logs: `oom-killer invoked`, `KILLED` in kernel logs
- Container restarts with exit code 137

```bash
# Check current Redis memory usage
redis-cli -u "$REDIS_URL" INFO memory | grep used_memory_human

# Check Redis maxmemory setting
redis-cli -u "$REDIS_URL" CONFIG GET maxmemory

# If memory is near limit, flush non-critical cache keys
redis-cli -u "$REDIS_URL" FLUSHDB ASYNC
# WARNING: This clears all cache; DB reads will spike temporarily
```

**Long-term fix in `docker-compose.yml` or Redis config:**
```yaml
redis:
  command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
```

---

## C. Connection Limit Reached

### Symptoms
- Logs: `max number of clients reached`
- Redis: `CONFIG GET maxclients` shows limit near or exceeded

```bash
# Check current client count
redis-cli -u "$REDIS_URL" INFO clients | grep connected_clients

# Check maxclients setting
redis-cli -u "$REDIS_URL" CONFIG GET maxclients

# If needed, increase limit temporarily
redis-cli -u "$REDIS_URL" CONFIG SET maxclients 200

# Check for stuck connections from indexer
redis-cli -u "$REDIS_URL" CLIENT LIST | grep -c "cmd=subscribe"
```

---

## Cache State After Recovery

When Redis comes back online, the cache is empty (cold start). The indexer automatically repopulates it on subsequent API calls. During this warmup period, DB load increases:

```bash
# Monitor DB query rate during cache warmup
psql "$DATABASE_URL" -c "
  SELECT calls, mean_exec_time, query
  FROM pg_stat_statements
  WHERE calls > 10
  ORDER BY total_exec_time DESC
  LIMIT 10;
"

# Monitor indexer API response times
watch -n 5 'curl -s http://localhost:4000/metrics | grep http_request_duration_seconds_bucket'
```

Cache warms up automatically as API calls hit the DB. Typically restores to normal latency within 5-10 minutes of traffic.

---

## SSE Reconnection After Redis Recovery

Clients connected via Server-Sent Events during the Redis outage will not receive replayed events from the Redis Streams buffer (which was cleared). Clients should reload the page to fetch current state via REST API:

```bash
# Check SSE connections
curl http://localhost:4000/health/details \
  -H "Authorization: Bearer $HEALTH_DETAILS_TOKEN" \
  | jq '.sseConnections'
```

Frontend automatically reconnects SSE on disconnect but will not replay missed events. This is by design — the REST API provides current state.

---

## Verification After Recovery

```bash
# 1. Confirm Redis health
curl http://localhost:4000/health | jq '.checks.redis'
# Expected: {"status": "ok"}

# 2. Confirm API latency recovered
curl -w "@-" -s -o /dev/null http://localhost:4000/listings <<'EOF'
     time_total:  %{time_total}\n
EOF
# Expected: < 0.1 seconds with warm cache

# 3. Verify indexer continues processing
curl -s http://localhost:4000/metrics | grep indexer_stalled
# Expected: indexer_stalled 0
```

---

## User Communication

Redis outage typically does not require a status page update unless latency exceeds 2 seconds. If it does:

```
[Status Page]
Some users may experience slower load times on listings and auction pages.
All marketplace functions remain available. We are working to restore
full performance. No data or funds are at risk.
```

---

## Post-Incident Review Template

```markdown
## Incident: Redis Outage — [Date]

**Duration:** [start] to [resolution]
**Root Cause:** [OOM | container crash | connection limit | network]
**Impact:** API p95 latency increased from [Xms] to [Yms] for [N] minutes

**Timeline:**
- T+0: /health reported Redis down
- T+Xm: Root cause identified
- T+Ym: Redis restarted
- T+Zm: Cache warmed; latency restored

**Action Items:**
- [ ] Set Redis maxmemory + eviction policy
- [ ] Enable Redis persistence (AOF) for faster recovery
- [ ] Add Redis memory alert at 80%
```

---

## Owner & Contacts

| Role | Contact | Escalation |
|---|---|---|
| **Primary:** DevOps | ops@elcarehub.xyz | Slack #alerts |
| **Secondary:** Backend Lead | backend-lead@elcarehub.xyz | If API impact > 5min |

---

## Related Runbooks

- [Database Outage](./database-outage.md)
- [Stalled Ingestion](./stalled-ingestion.md)
