# Runbook: Compromised Admin Key

**Incident Type:** Admin Stellar secret key exposed, leaked, or suspected compromised  
**Severity:** CRITICAL — Attacker can pause contract, drain treasury, rotate admin, modify fees

---

## ⚠️ IMMEDIATE ACTIONS — Before Reading Further

If you have **confirmed compromise** (key seen in logs/git/chat):

```
1. DO NOT use the compromised key — any action tips off the attacker
2. Immediately check if admin is still yours:
   stellar contract invoke --id $MARKETPLACE_CONTRACT_ID --rpc-url $STELLAR_RPC_URL -- get_admin
3. If admin address is still yours: JUMP TO "Emergency Transfer" section below
4. If admin address changed: JUMP TO "Admin Lost — Contract Recovery" section
```

---

## Detection

| Signal | Meaning |
|---|---|
| Key found in git history / CI logs / Sentry | Leak confirmed — act immediately |
| Unauthorized `ADMIN_PAUSED` or `ADMIN_ACCEPTED` event in indexer | Active exploit in progress |
| Prometheus: `elcarehub_reentrancy_guard_triggered_total` spike | Contract being probed |
| Treasury balance decreasing without expected protocol fees | Potential fund drain |
| Contract settings changed (fee BPS, whitelist) without operator action | Unauthorized admin activity |

### Check for Unauthorized Admin Activity
```bash
# Check recent admin-level events in the indexer
psql "$DATABASE_URL" -c "
  SELECT \"eventType\", actor, data, \"ledgerSequence\", \"ledgerTimestamp\"
  FROM \"MarketplaceEvent\"
  WHERE \"eventType\" IN (
    'CONTRACT_PAUSED', 'CONTRACT_UNPAUSED',
    'ADMIN_PROPOSED', 'ADMIN_ACCEPTED', 'ADMIN_PROPOSAL_CANCELLED',
    'COLLECTION_FEE_SET', 'ARTIST_REVOKED'
  )
  ORDER BY \"ledgerSequence\" DESC
  LIMIT 20;
"

# Check if a pending admin proposal exists (may not yet be accepted)
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- get_pending_admin

# Verify treasury balance has not been drained
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- get_treasury
```

---

## Response: Admin Key Still Under Control

**Act within 7 minutes** to beat any pending proposal acceptance.

### Step 1 — Pause the Contract Immediately
```bash
# Lock down new user transactions while you rotate keys
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --source "$CURRENT_ADMIN_SECRET" \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" \
  -- admin_pause \
  --admin "$CURRENT_ADMIN_PUBLIC"

# Verify pause
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- is_paused
# Expected: true
```

### Step 2 — Cancel Any Pending Admin Proposal
```bash
# If attacker submitted a proposal, cancel it BEFORE it is accepted
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --source "$CURRENT_ADMIN_SECRET" \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" \
  -- cancel_admin_proposal \
  --current_admin "$CURRENT_ADMIN_PUBLIC"
```

### Step 3 — Initiate Emergency Admin Transfer
```bash
# Generate new admin keypair (on an air-gapped machine if possible)
stellar keys generate elcarehub-admin-v2 --no-fund

# Get the new public key
NEW_ADMIN_PUBLIC=$(stellar keys public-key elcarehub-admin-v2)
echo "New admin: $NEW_ADMIN_PUBLIC"

# Fund new account on mainnet (min 1 XLM reserve)
# On testnet:
curl "https://friendbot.stellar.org?addr=$NEW_ADMIN_PUBLIC"

# Step 1: Current admin proposes the new admin
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --source "$CURRENT_ADMIN_SECRET" \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" \
  -- transfer_admin \
  --current_admin "$CURRENT_ADMIN_PUBLIC" \
  --new_admin "$NEW_ADMIN_PUBLIC"

# Step 2: New admin accepts (IMMEDIATELY — do not wait)
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --source "$(stellar keys secret-key elcarehub-admin-v2)" \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" \
  -- accept_admin \
  --new_admin "$NEW_ADMIN_PUBLIC"

# Verify transfer
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- get_admin
# Expected: NEW_ADMIN_PUBLIC
```

### Step 4 — Update Deployment Secrets

1. **Remove** old `ADMIN_SECRET` from all environments (CI, Kubernetes, Railway, Vercel)
2. **Rotate** old `STELLAR_SECRET_KEY` in deployment scripts
3. **Store** new key in the approved secrets manager (see [secret-inventory.md](../secret-inventory.md))
4. Redeploy any services using the compromised key

### Step 5 — Unpause After Verification
```bash
# Verify all settings are unchanged (fee BPS, treasury, whitelist)
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- get_protocol_fee

stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- get_treasury

# Unpause once confident settings are correct
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --source "$(stellar keys secret-key elcarehub-admin-v2)" \
  --rpc-url "$STELLAR_RPC_URL" \
  --network-passphrase "$STELLAR_NETWORK_PASSPHRASE" \
  -- admin_unpause \
  --admin "$NEW_ADMIN_PUBLIC"
```

---

## Response: Admin Key Lost / Attacker Has Control

If `get_admin` returns an address that is not yours, the 2-step rotation requires the new admin to accept. There is **no on-chain recovery** from a completed admin transfer in a non-custodial design.

### Options

1. **If proposal is pending (attacker proposed, has not accepted):**  
   — Generate a new key, fund it, and race to submit `accept_admin` with a different address before the attacker does  
   — The proposal has a 7-day TTL (`ADMIN_PROPOSAL_TTL = 604800s`)

2. **If admin is already transferred:**  
   — Deploy a new contract instance with the correct admin  
   — Migrate users and liquidity to the new contract  
   — Coordinate with Stellar validators if a freeze is needed

3. **Contact Stellar Foundation** for extreme scenarios involving large user funds.

---

## Prohibited Actions

- ❌ **Do not use the compromised key** for ANY operation — attacker may be monitoring for it
- ❌ **Do not post the public key of the new admin** until after `accept_admin` completes
- ❌ **Do not store the new key in `.env` files or git** — use your secrets manager
- ❌ **Do not skip the proposal expiry check** — always verify `get_pending_admin` first
- ❌ **Do not unpause** until you have verified treasury and fee settings are intact

---

## Communication

### Internal (Immediate)
```
[CRITICAL — Admin Key Incident]
The ElcareHub admin key may be compromised. Contract is paused. 
Emergency admin transfer in progress. Do not share new key details 
until transfer is complete. Contact [CTO] immediately.
```

### Public Status Page (after containment)
```
[Status Page]
ElcareHub is temporarily paused for a critical security maintenance procedure.
User funds are safe. We will restore service within [X] hours.
No user action is required. Follow @ElcareHub for updates.
```

### Disclosure (post-resolution, within 48 hours)
```
On [date], we detected that the ElcareHub admin key may have been exposed.
We immediately paused the marketplace and rotated the admin key.
User funds were not affected. We have revoked the exposed key and 
strengthened our key management processes. A full post-mortem is available at [URL].
```

---

## Post-Incident Checklist

- [ ] Compromised key revoked from all environments and secrets managers
- [ ] New admin key stored exclusively in approved secrets manager
- [ ] Git history scanned for any secret exposure (`gitleaks detect`)
- [ ] All CI/CD workflow secrets rotated
- [ ] Contract settings verified (fee BPS, treasury, whitelist, price bounds)
- [ ] Treasury balance reconciled against protocol fee events
- [ ] Users notified if funds were at risk
- [ ] Post-mortem published (internal and external versions)
- [ ] Key rotation interval reviewed and scheduled

---

## Post-Incident Review Template

```markdown
## Incident: Compromised Admin Key — [Date]

**How Discovered:** [git leak | CI log | user report | monitoring]
**Time to Contain:** [minutes from discovery to pause]
**Time to Rotate:** [minutes from pause to new admin confirmed]

**Root Cause:** [how the key was exposed]
**Impact:** [any unauthorized actions | funds affected | none]

**Timeline:**
- T+0: Exposure detected
- T+Xm: Contract paused
- T+Ym: Pending proposal cancelled (if any)
- T+Zm: Emergency admin transfer completed
- T+Wm: Contract unpaused; operations resumed

**Action Items:**
- [ ] Implement HSM or cloud KMS for admin key storage
- [ ] Add Gitleaks pre-commit hook (not just CI)
- [ ] Schedule quarterly key rotation for all admin keys
- [ ] Document key storage procedure in SECURITY.md
```

---

## Owner & Contacts

| Role | Contact | Escalation |
|---|---|---|
| **Primary:** Security Lead | security@elcarehub.xyz | Immediate call |
| **Secondary:** CTO | cto@elcarehub.xyz | Always cc'd on admin key incidents |
| **Legal (if funds lost)** | legal@elcarehub.xyz | Within 1 hour |

**Time-sensitive:** Admin proposal TTL is 7 days. Any pending proposal must be cancelled within that window.

---

## Related Runbooks

- [Contract Pause](./contract-pause.md)
- [Secret Inventory and Rotation](../secret-inventory.md)
