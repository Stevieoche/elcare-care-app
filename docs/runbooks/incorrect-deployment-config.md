# Runbook: Incorrect Deployment Configuration

**Incident Type:** Environment variables misconfigured; frontend/indexer pointing at wrong contract or network  
**Severity:** HIGH — Silently broken features; potential duplicate transactions or data loss

---

## Detection

### Automatic Signals
- **CI/CD:** `release-validate` job fails — `scripts/validate-compatibility.sh` finds version mismatch
- **Indexer:** `GET /version` returns unexpected schema or migration versions
- **Health:** `GET /health/details` shows version mismatches between components
- **Sentry:** Spike in `ContractNotFound`, `ListingNotFound`, or `tx_bad_auth` errors after deployment
- **Indexer:** No events ingested for > 5 minutes after deployment (wrong contract ID)

### Manual Check
```bash
# Check all component versions are consistent
curl http://localhost:4000/version | jq
# Check: api, eventSchema, dbMigration, gitSha all match expected release

# Verify contract IDs are live on the correct network
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- version
# Expected: "1.1.0" (not an error)

stellar contract invoke \
  --id "$LAUNCHPAD_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- version
# Expected: the launchpad version string

# Verify indexer is tracking the right contract
psql "$DATABASE_URL" -c "
  SELECT \"contractId\", type, label, \"lastLedger\", active
  FROM \"TrackedContract\";
"
# Expected: rows match MARKETPLACE_CONTRACT_ID and LAUNCHPAD_CONTRACT_ID in .env
```

---

## A. Wrong Contract ID Deployed to Frontend

### Symptoms
- Users see "Listing not found" for all listings
- All buy/sell transactions fail with `ContractNotFound`
- `NEXT_PUBLIC_CONTRACT_ID` points to a test/old contract

### Diagnosis
```bash
# Compare frontend contract ID vs indexer
echo "Frontend: $NEXT_PUBLIC_CONTRACT_ID"
echo "Indexer:  $MARKETPLACE_CONTRACT_ID"

# Both should match. Also verify against the contract deployed on-chain:
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- get_active_listings_count
# If this works but UI shows no listings → frontend has wrong contract ID
```

### Fix
```bash
# Update frontend environment variable
# On Vercel: Settings → Environment Variables → NEXT_PUBLIC_CONTRACT_ID
# Update to match the correct deployed contract address

# Then redeploy
# Vercel: Force a new deployment (push a commit or click Redeploy)
```

**Verification:** Users can see listings; contract calls succeed.

---

## B. Wrong Network Passphrase

### Symptoms
- All transactions fail with `tx_bad_auth`
- Freighter shows a different passphrase than the frontend expects

### Diagnosis
```bash
# Check frontend passphrase
echo "NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE = $NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE"

# Check what the actual network uses
stellar rpc --rpc-url $STELLAR_RPC_URL getNetwork | jq

# Passphrases:
# Testnet: "Test SDF Network ; September 2015"
# Mainnet: "Public Global Stellar Network ; September 2015"
```

### Fix
Update `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` in the deployment environment and redeploy frontend.

---

## C. Indexer Tracking Wrong Contract

### Symptoms
- `GET /listings` returns 0 results or stale results
- Indexer events show correct count of ledgers processed but no marketplace events
- `TrackedContract` table has wrong `contractId`

### Diagnosis
```bash
# Check what the indexer is tracking
psql "$DATABASE_URL" -c "SELECT \"contractId\", type, \"lastLedger\" FROM \"TrackedContract\";"

# Compare with expected
echo "Expected: $MARKETPLACE_CONTRACT_ID"
```

### Fix

**Option 1: Update env and restart (preferred for new deployments)**
```bash
# Update indexer .env with correct contract IDs
# MARKETPLACE_CONTRACT_ID=C...correct...
# LAUNCHPAD_CONTRACT_ID=C...correct...

# Wipe and re-seed TrackedContract rows
psql "$DATABASE_URL" -c "
  DELETE FROM \"TrackedContract\";
  DELETE FROM \"SyncState\";
  DELETE FROM \"LedgerCheckpoint\";
  DELETE FROM \"MarketplaceEvent\";
  DELETE FROM \"Listing\";
  DELETE FROM \"Auction\";
  DELETE FROM \"Offer\";
"
# WARNING: This is a full re-index. Appropriate only if the contract changed.

docker compose restart indexer
# The indexer will re-seed TrackedContract from env vars on startup
```

**Option 2: Update in-place (if only one contract ID is wrong)**
```bash
psql "$DATABASE_URL" -c "
  UPDATE \"TrackedContract\"
  SET \"contractId\" = 'C...correct...',
      \"lastLedger\" = 0,
      \"lastLedgerHash\" = NULL,
      \"updatedAt\" = NOW()
  WHERE \"contractId\" = 'C...wrong...';

  UPDATE \"SyncState\"
  SET \"lastLedger\" = 0,
      \"lastLedgerHash\" = NULL
  WHERE id = 1;
"

docker compose restart indexer
# Re-index from scratch for this contract
```

---

## D. Database Migration Version Mismatch

### Symptoms
- Indexer crashes on startup: `The table TableName does not exist`
- `GET /version` shows `dbMigration` older than expected
- CI `release-validate` job fails

### Diagnosis
```bash
# Check what migration the DB is at
psql "$DATABASE_URL" -c "
  SELECT migration_name, finished_at
  FROM \"_prisma_migrations\"
  ORDER BY finished_at DESC
  LIMIT 5;
"

# Check what migration the codebase expects
cat indexer/prisma/schema.prisma | grep -A 2 "datasource"
ls indexer/prisma/migrations/ | tail -5
```

### Fix
```bash
# Stop indexer
docker compose stop indexer

# Apply pending migrations
cd indexer
npx prisma migrate deploy

# Verify migration applied
npx prisma migrate status

# Restart indexer
docker compose start indexer
```

**Never run `prisma migrate dev` in production.** That resets the migration history.

---

## E. Event Schema Version Mismatch (Indexer ↔ Frontend)

### Symptoms
- Frontend parses event types incorrectly after a deployment
- `X-Event-Schema-Version` header in API responses doesn't match what frontend expects
- `validate-error-coverage.mjs` script fails in CI

### Diagnosis
```bash
# Check current event schema version
curl -I http://localhost:4000/listings | grep X-Event-Schema-Version

# Check expected version
cat versions.toml | grep event_schema_version
```

### Fix
Align `versions.toml`, `indexer/src/events/`, and `frontend/src/lib/contract.ts`. Run the CI validation:

```bash
bash scripts/validate-compatibility.sh
```

If versions are intentionally bumped, redeploy both indexer and frontend together.

---

## F. NEXT_PUBLIC_ Variable Accidentally Set to Sensitive Value

### Symptoms
- Browser DevTools or page source reveals a secret (JWT, private key) in `window.__NEXT_DATA__`
- Security scanner flags `NEXT_PUBLIC_*` variable containing `S...` (Stellar secret key format) or `eyJ` (JWT prefix)

### Immediate Actions
1. **Revoke the exposed secret immediately** (see [secret-inventory.md](../secret-inventory.md))
2. Remove the variable from the deployment environment
3. Redeploy frontend
4. Verify the secret no longer appears in page source

**Rule:** Only non-sensitive identifiers belong in `NEXT_PUBLIC_*` variables. See the [secret inventory](../secret-inventory.md) for the complete classification.

---

## Startup Configuration Validation

The indexer runs startup diagnostics that reject missing or misconfigured settings:

```bash
# Simulate startup check
cd indexer
npm run validate-config
# Expected: all required variables present; contract IDs are valid format (C...)
# If fails: output shows which variables are missing or malformed
```

**Required variables that fail startup if missing:**
- `DATABASE_URL`
- `REDIS_URL`
- `STELLAR_RPC_URL`
- `MARKETPLACE_CONTRACT_ID` (or `TRACKED_CONTRACTS`)
- `STELLAR_NETWORK`

---

## Prohibited Actions

- ❌ **Do not change `MARKETPLACE_CONTRACT_ID` on a live indexer** without planning a full re-index
- ❌ **Do not skip `prisma migrate deploy`** when deploying a new indexer image
- ❌ **Do not run `prisma migrate dev`** in production
- ❌ **Do not store Stellar secret keys in `NEXT_PUBLIC_*` variables**
- ❌ **Do not set the same variable to different values** in frontend and indexer (network, contract ID)

---

## Pre-Deployment Checklist

Before any deployment to production:

```bash
# 1. Run version consistency validator
bash scripts/validate-compatibility.sh

# 2. Check contract IDs match production deployment
stellar contract invoke --id $MARKETPLACE_CONTRACT_ID --rpc-url $STELLAR_RPC_URL -- version

# 3. Check network passphrase matches RPC
stellar rpc --rpc-url $STELLAR_RPC_URL getNetwork | jq '.passphrase'

# 4. Ensure no NEXT_PUBLIC_ variable contains secret material
grep -E 'NEXT_PUBLIC_.*=(S[0-9A-Z]{55}|eyJ)' frontend/elcarehub-app/.env* 2>/dev/null
# Expected: no output (no matches)

# 5. Verify DB migrations are applied
cd indexer && npx prisma migrate status
# Expected: "All migrations have been applied"
```

---

## Rollback Procedure

If a deployment introduced configuration errors:

```bash
# Revert indexer to previous Docker image
docker compose stop indexer
docker tag elcarehub-indexer:<new_tag> elcarehub-indexer:broken-$(date +%Y%m%d)
docker tag elcarehub-indexer:<previous_tag> elcarehub-indexer:latest
docker compose up -d indexer

# Revert frontend on Vercel:
# Go to Vercel → Deployments → select previous deployment → Rollback to this Deployment

# If DB migrations were applied during the broken deployment:
# (Only revert if migration was destructive and caused data loss — otherwise leave in place)
```

---

## Post-Incident Review Template

```markdown
## Incident: Incorrect Deployment Configuration — [Date]

**Misconfiguration:** [wrong contract ID | wrong network | wrong passphrase | version mismatch]
**Duration:** [deployment time] to [fix time]
**Impact:** [N] users could not [describe feature] for [Y] minutes

**Root Cause:** [wrong env var set in deployment pipeline]

**Action Items:**
- [ ] Add config validation to deployment pipeline (fail fast)
- [ ] Add post-deploy smoke test verifying contract ID and network
- [ ] Update deployment checklist in docs/guides/deployment.md
- [ ] Review which envs are tested in CI vs production
```

---

## Owner & Contacts

| Role | Contact | Escalation |
|---|---|---|
| **Primary:** DevOps | ops@elcarehub.xyz | Slack #deploys |
| **Secondary:** Backend Lead | backend-lead@elcarehub.xyz | For contract ID changes |

---

## Related Runbooks

- [Wallet Incompatibility](./wallet-incompatibility.md)
- [Stalled Ingestion](./stalled-ingestion.md)
- [Secret Inventory](../secret-inventory.md)
