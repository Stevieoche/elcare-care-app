# Runbook: Pinata / IPFS Outage

**Incident Type:** Pinata API unavailable or NFT metadata unreachable  
**Severity:** MEDIUM — New listing creation fails; existing NFT images may not load

---

## Detection

### Automatic Signals
- **Frontend Sentry errors:** `Failed to upload file to Pinata`, `PinataSDK: 503`
- **Indexer logs:** `Failed to fetch IPFS metadata for CID: ...`, repeated HTTP 5xx from Pinata gateway
- **User reports:** NFT images not loading; listing creation flow fails at "Upload Artwork" step

### Manual Check
```bash
# Test Pinata API availability (requires your JWT)
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $PINATA_JWT" \
  https://api.pinata.cloud/data/testAuthentication
# Expected: 200

# Test IPFS gateway (public, no auth needed)
curl -s -o /dev/null -w "%{http_code}" \
  "https://gateway.pinata.cloud/ipfs/QmXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
# Expected: 200

# Check Pinata status page
curl -s https://status.pinata.cloud/ | grep -i "operational\|incident"
```

---

## Impact Assessment

| Function | Impact | Fallback |
|---|---|---|
| New listing creation | Broken — cannot upload artwork/metadata | None — must queue and retry |
| Existing NFT images in UI | Broken — gateway returns error | No automatic fallback |
| Indexer IPFS metadata fetch | Degraded — search/description fields not populated | Indexer continues; metadata fields remain null |
| Contract operations (buy, bid) | **Not affected** — Soroban contracts don't rely on Pinata | Continues normally |
| User funds | **Not affected** | N/A |

---

## Containment

**DO:**
- ✅ Check Pinata's official status page: https://status.pinata.cloud
- ✅ Display a user-facing maintenance banner on the listing creation page
- ✅ Allow in-progress listings and auctions to continue — contract operations unaffected
- ✅ Queue failed upload attempts for retry (if frontend supports it)

**DO NOT:**
- ❌ Invalidate or delete CIDs stored in the database during an outage
- ❌ Swap to a different IPFS gateway mid-session (users' browsers may have cached the gateway URL)
- ❌ Expose the `PINATA_JWT` in frontend error messages or logs

---

## A. Pinata Gateway Down (Existing Images Not Loading)

### Symptoms
- Images at `https://gateway.pinata.cloud/ipfs/<CID>` return 503 or timeout
- Browser console shows: `net::ERR_NAME_NOT_RESOLVED` or `ERR_TIMED_OUT`

### Mitigation — Use Fallback Public Gateway

The IPFS CID is stored permanently in the contract and database. Any IPFS gateway can serve it.

```bash
# Test fallback gateways
CID="QmExample..."

# Cloudflare IPFS (most reliable free option)
curl -s -o /dev/null -w "%{http_code}" "https://cloudflare-ipfs.com/ipfs/$CID"

# IPFS public gateway
curl -s -o /dev/null -w "%{http_code}" "https://ipfs.io/ipfs/$CID"

# Dweb.link (Protocol Labs)
curl -s -o /dev/null -w "%{http_code}" "https://dweb.link/ipfs/$CID"
```

**Temporary fix for frontend:**

Update `NEXT_PUBLIC_PINATA_GATEWAY` in the deployment environment to a fallback gateway:

```bash
# Set to Cloudflare IPFS as temporary fallback
NEXT_PUBLIC_PINATA_GATEWAY=https://cloudflare-ipfs.com

# Redeploy frontend (Vercel: push a new deploy trigger or update env var)
```

**Verification:** Images load via fallback gateway; check Sentry for image load errors.

---

## B. Pinata Upload API Down (New Listings Cannot Be Created)

### Symptoms
- Listing creation fails at "Upload Artwork" step
- Server logs: `Pinata upload failed: 503`, `ECONNREFUSED api.pinata.cloud`

### User Communication

Display a banner in the listing creation wizard:

```
IPFS storage is temporarily unavailable due to a service outage.
Listing creation is disabled until service is restored.
Your artwork has not been lost. Please try again in 30 minutes.
```

### Monitoring for Recovery

```bash
# Poll Pinata API health (run every 5 minutes until recovered)
watch -n 300 '
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $PINATA_JWT" \
    https://api.pinata.cloud/data/testAuthentication)
  echo "$(date) - Pinata API status: $STATUS"
'
# Remove banner when STATUS returns 200
```

### After Recovery — Retry Failed Uploads

If users attempted listing creation during the outage:
1. Check Sentry for failed upload error events to identify affected users
2. Notify affected users to retry their listing creation
3. No database records were created for failed uploads — they must start from the beginning

---

## C. PINATA_JWT Expired or Revoked

### Symptoms
- Pinata API returns 401 or 403
- Other Pinata gateways still work (CID-based reads don't need auth)

```bash
# Verify JWT is valid
curl -s -H "Authorization: Bearer $PINATA_JWT" \
  https://api.pinata.cloud/data/testAuthentication
# If 401/403: JWT is invalid
```

### Rotation Steps
1. Log in to [app.pinata.cloud](https://app.pinata.cloud) → **API Keys**
2. Revoke the expired/compromised key
3. Generate a new JWT key
4. Update `PINATA_JWT` in production secrets (Vercel env vars, Kubernetes secret, etc.)
5. Redeploy the frontend
6. Verify listing creation works: test with a small image upload

```bash
# Test new JWT immediately after rotation
NEW_JWT="eyJ..."
curl -s -H "Authorization: Bearer $NEW_JWT" \
  https://api.pinata.cloud/data/testAuthentication
# Expected: 200 {"message": "Congratulations! You are communicating with the Pinata API!"}
```

---

## D. Indexer IPFS Metadata Fetch Failures

The indexer fetches IPFS metadata asynchronously to populate `title`, `description`, and `artistName` fields for full-text search. During a Pinata outage, these fields remain null.

### Impact
- Listing search by artist name or description returns fewer results
- Full-text search index is incomplete

### Recovery After Outage

When Pinata recovers, the indexer will retry failed metadata fetches automatically on next scan cycle. No manual action is required unless metadata has been missing for > 24 hours:

```bash
# Check for listings missing metadata
psql "$DATABASE_URL" -c "
  SELECT COUNT(*) as missing_metadata
  FROM \"Listing\"
  WHERE title IS NULL
    AND \"createdAt\" < NOW() - INTERVAL '1 hour';
"

# If count > 0 after outage recovery, trigger a metadata backfill
# (Check indexer for a backfill-metadata command)
cd indexer
npm run backfill-metadata -- --force
```

---

## Verification After Recovery

```bash
# 1. Confirm Pinata API is operational
curl -s -H "Authorization: Bearer $PINATA_JWT" \
  https://api.pinata.cloud/data/testAuthentication
# Expected: 200

# 2. Confirm gateway serves existing CIDs
# Use a known CID from the database
KNOWN_CID=$(psql "$DATABASE_URL" -tAc "
  SELECT data->>'cid' FROM \"MarketplaceEvent\"
  WHERE \"eventType\" = 'LISTING_CREATED' LIMIT 1
")
curl -s -o /dev/null -w "%{http_code}" \
  "$NEXT_PUBLIC_PINATA_GATEWAY/ipfs/$KNOWN_CID"
# Expected: 200

# 3. Test listing creation end-to-end (manual)
# Use the staging environment if available

# 4. Remove the maintenance banner from the frontend
# 5. Verify Sentry error rate returns to baseline
```

---

## Communication Timeline

| Time | Action |
|---|---|
| **T+0** | Detect outage; disable listing creation form with maintenance message |
| **T+15m** | Post status update: "IPFS storage unavailable; working to resolve" |
| **T+30m** | Check for ETA from Pinata status page; update users |
| **Recovery** | Re-enable listing creation; post "Resolved" update |
| **+2h** | Notify affected users who attempted to create listings during outage |

---

## Post-Incident Review Template

```markdown
## Incident: Pinata Outage — [Date]

**Duration:** [start] to [resolution]
**Root Cause:** [Pinata service outage | JWT expiry | gateway degradation]
**Impact:** Listing creation blocked for [N] minutes; [X] affected user attempts

**Action Items:**
- [ ] Add secondary IPFS pinning service (Infura, web3.storage) as fallback
- [ ] Implement upload queue with retry for failed Pinata uploads
- [ ] Set PINATA_JWT expiry alert (30 days before expiry)
- [ ] Add Pinata to uptime monitoring dashboard
```

---

## Owner & Contacts

| Role | Contact | Escalation |
|---|---|---|
| **Primary:** Frontend Lead | frontend@elcarehub.xyz | Slack #alerts |
| **Secondary:** DevOps | ops@elcarehub.xyz | If > 30min unresolved |
| **Pinata Support** | support@pinata.cloud | For account-level issues |

---

## Related Runbooks

- [Incorrect Deployment Configuration](./incorrect-deployment-config.md)
- [Secret Inventory](../secret-inventory.md)
