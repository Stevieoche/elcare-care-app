# Runbook: Contract Pause and Unpause

**Incident Type:** Emergency halt of marketplace operations  
**Severity:** CRITICAL — All new buys, bids, and offers are blocked while paused

---

## When to Use

| Trigger | Pause Type | Recommended Scope |
|---|---|---|
| Active exploit detected | Immediate | Global pause |
| Critical bug in specific function | Targeted | Function-level pause |
| NFT collection flagged as fraudulent | Targeted | Collection-level pause |
| Scheduled maintenance | Planned | Global pause with advance notice |
| Admin key suspected compromised | Immediate | Global pause (see [compromised-admin-key.md](./compromised-admin-key.md)) |

---

## Pause Types

The contract supports three independent circuit-breaker axes:

| Axis | Command | Effect |
|---|---|---|
| **Global** | `admin_pause` | Blocks ALL state-changing operations |
| **Per-collection** | `pause_collection` | Blocks operations for one NFT collection |
| **Per-function** | `pause_function` | Blocks one specific entry-point |

Use the narrowest pause scope that contains the incident.

---

## A. Global Pause (Emergency)

### Execute Immediately
```bash
# 0. Confirm you hold the admin key
stellar keys public-key elcarehub-admin

# 1. Verify admin address on contract matches yours
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- get_admin
# Expected: your admin public key

# 2. Pause ALL operations
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" \
  -- admin_pause \
  --admin "$ADMIN_PUBLIC"

# 3. Verify paused state (must confirm before moving on)
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- is_paused
# Expected: true
```

**Time target:** Complete within 2 minutes of incident confirmation.

### What Pausing Does and Does NOT Do

**DOES pause (contract reverts with ContractPaused):**
- `buy_artwork`
- `create_listing`, `update_listing`, `cancel_listing`
- `create_auction`, `place_bid`, `finalize_auction`, `cancel_auction`
- `make_offer`, `accept_offer`, `reject_offer`, `withdraw_offer`, `reclaim_offer`

**DOES NOT pause (still active):**
- All read-only views (`get_listing`, `get_auction`, `get_admin`, etc.)
- `expire_listing` (permissionless maintenance — intentionally unblocked)
- Admin functions (`transfer_admin`, `set_protocol_fee`, etc.)
- `version()` and `is_paused()` checks

**Existing escrow is safe:** NFTs in contract escrow and tokens held by the contract remain secure during pause. The contract holds these funds and cannot be drained by a pause state.

---

## B. Collection-Level Pause

Use when a specific NFT collection is involved in fraud or has a bug:

```bash
# Pause all operations for a collection
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" \
  -- pause_collection \
  --admin "$ADMIN_PUBLIC" \
  --collection "$COLLECTION_ADDRESS"

# Verify
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- is_collection_paused \
  --collection "$COLLECTION_ADDRESS"
# Expected: true
```

---

## C. Function-Level Pause

Use to disable a specific entry-point while keeping others available:

Valid function names: `"buy_artwork"`, `"create_listing"`, `"place_bid"`, `"create_auction"`, `"make_offer"`, `"accept_offer"`

```bash
# Example: pause only buy_artwork while investigating a payment bug
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" \
  -- pause_function \
  --admin "$ADMIN_PUBLIC" \
  --function_name "buy_artwork"

# Verify
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- is_function_paused \
  --function_name "buy_artwork"
# Expected: true
```

---

## Verifying Pause Took Effect

After pausing, confirm user transactions are rejected:

```bash
# Attempt a buy_artwork as a test — should fail with ContractPaused
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- buy_artwork \
  --buyer "GBTEST..." \
  --listing_id 1

# Expected error in output: ContractPaused (error code matches MarketplaceError::ContractPaused)
```

Also check the indexer event log for the pause event:
```bash
psql "$DATABASE_URL" -c "
  SELECT \"eventType\", actor, \"ledgerTimestamp\"
  FROM \"MarketplaceEvent\"
  WHERE \"eventType\" = 'CONTRACT_PAUSED'
  ORDER BY \"ledgerSequence\" DESC
  LIMIT 3;
"
```

---

## Keeper Behavior During Pause

The keeper bot calls `expire_listing`, `finalize_auction`, and `reclaim_offer`. These permissionless calls are **not blocked by global pause** (`expire_listing` is intentionally unblocked). To halt the keeper during maintenance:

```bash
# Disable keeper temporarily
# In indexer/.env, set:
KEEPER_ENABLED=false

docker compose restart indexer
```

Re-enable after unpause:
```bash
KEEPER_ENABLED=true
KEEPER_DRY_RUN=false   # if running live
docker compose restart indexer
```

---

## Unpause Procedure

### Checklist Before Unpausing

- [ ] Root cause identified and documented
- [ ] Fix deployed (contract upgrade or parameter change) OR investigation concluded with no action needed
- [ ] Contract settings verified: fee BPS, treasury address, token whitelist
- [ ] No pending exploit transactions in mempool
- [ ] Incident report drafted (can be posted after unpause)
- [ ] Status page updated to "Restoring service"

### Execute Unpause

```bash
# Global unpause
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --source "$ADMIN_SECRET" \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" \
  -- admin_unpause \
  --admin "$ADMIN_PUBLIC"

# Verify
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- is_paused
# Expected: false
```

### Post-Unpause Verification

```bash
# 1. Verify indexer picks up the UNPAUSED event
psql "$DATABASE_URL" -c "
  SELECT \"eventType\", actor, \"ledgerTimestamp\"
  FROM \"MarketplaceEvent\"
  WHERE \"eventType\" = 'CONTRACT_UNPAUSED'
  ORDER BY \"ledgerSequence\" DESC
  LIMIT 1;
"

# 2. Monitor Prometheus for anomalous activity
curl -s http://localhost:4000/metrics | grep -E 'elcarehub_sales_total|elcarehub_reentrancy_guard'

# 3. Confirm /readyz is healthy
curl http://localhost:4000/readyz
# Expected: 200 {"ready": true}

# 4. Test a read-only query to confirm contract state is accessible
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- get_active_listings_count
```

---

## Communication

### When Pausing
```
[Status Page — Immediate]
ElcareHub is temporarily paused due to a security investigation.
No transactions can be submitted until the pause is lifted.
Existing listings and funds are safe. We will update within 30 minutes.
```

### While Paused
Every 30 minutes:
```
[Status Page Update — T+30min]
We are continuing our investigation. The marketplace remains paused.
No user action is required. Next update at [time].
```

### When Unpausing
```
[Status Page — Resolved]
ElcareHub has resumed normal operations. All marketplace functions are available.
[If applicable: We identified and resolved [brief description of issue].]
A detailed incident report will be published within 48 hours.
```

---

## Prohibited Actions During Pause

- ❌ **Do not run contract migrations** while investigating an active exploit
- ❌ **Do not unpause** without completing the pre-unpause checklist
- ❌ **Do not use `pause_function` instead of `admin_pause`** when a global exploit is suspected — function-level pause does not block all paths

---

## Tabletop Test Scenario

**Quarterly tabletop exercise — "Buy Bug":**

Scenario: A user reports they can buy their own listing (self-purchase). You see `SelfPurchaseNotAllowed` error code 17 is checked, but discover a code path where `listing.owner` bypasses the check for first-time sales.

1. Owner verifies admin key is accessible
2. Execute global pause within 2 minutes (timer)
3. Confirm `is_paused` returns true
4. Check recent `buy_artwork` transactions in indexer event log for anomalies
5. Draft a fix in the smart contract
6. Update this runbook with any discovered gaps
7. Unpause using checklist

**Participants:** Security Lead, Backend Lead, DevOps Engineer  
**Pass criteria:** Pause confirmed within 3 minutes; all checklist items completed; participant Q&A

---

## Post-Incident Review Template

```markdown
## Incident: Contract Pause — [Date]

**Trigger:** [exploit | bug | precautionary]  
**Pause scope:** [global | collection | function]  
**Duration paused:** [start] to [end]  
**Impacted transactions:** [N transactions blocked during pause window]

**Timeline:**
- T+0: Trigger detected
- T+Xm: Contract paused
- T+Ym: Root cause confirmed / investigation complete
- T+Zm: Contract unpaused; service restored

**User Impact:** [N users could not submit transactions during pause]

**Action Items:**
- [ ] Deploy fix for root cause (if exploit confirmed)
- [ ] Add monitoring for [specific on-chain event pattern]
- [ ] Schedule next tabletop exercise for [date]
```

---

## Owner & Contacts

| Role | Contact | Escalation |
|---|---|---|
| **Primary:** Security Lead | security@elcarehub.xyz | On-call 24/7 |
| **Secondary:** CTO | cto@elcarehub.xyz | Always cc'd |
| **Communications:** Marketing | marketing@elcarehub.xyz | Status page updates |

---

## Related Runbooks

- [Compromised Admin Key](./compromised-admin-key.md)
- [Incorrect Deployment Configuration](./incorrect-deployment-config.md)
