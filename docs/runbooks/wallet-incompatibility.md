# Runbook: Wallet Incompatibility

**Incident Type:** Freighter or Magic.link wallet fails to sign or submit transactions  
**Severity:** HIGH — Users cannot buy, bid, list, or interact with the marketplace

---

## Detection

### Automatic Signals
- **Sentry errors:** `Freighter not found`, `USER_REJECTED_ERROR`, `WalletSigningError`, `Magic.link: Failed to connect`
- **Prometheus:** `elcarehub_sales_total` drops unexpectedly; no new listings created
- **User reports:** "Transaction failed", "Wallet disconnected", "Can't connect wallet"

### Manual Triage
```bash
# Check recent frontend errors in Sentry
# Filter by: tags.context = "wallet"

# Check browser console for wallet errors (in-browser debugging):
# - "Freighter is not installed" → extension missing
# - "Transaction rejected by user" → user-side
# - "Failed to sign transaction" → possible API mismatch

# Verify contract addresses are correct on current network
curl http://localhost:4000/version | jq
# Cross-check: NEXT_PUBLIC_CONTRACT_ID matches deployed contract
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- version
# Expected: "1.1.0"
```

---

## Wallet Types and Failure Modes

| Wallet | Common Failure | Detection |
|---|---|---|
| **Freighter** (browser extension) | Extension not installed; wrong network; outdated version | `window.freighter` undefined; network passphrase mismatch |
| **Magic.link** (email/passkey) | API key invalid; session expired; Magic SDK version incompatible | 401 from Magic API; `MAGIC_LINK_ERROR` in Sentry |
| **Both** | Wrong `STELLAR_NETWORK` / passphrase in frontend env | All transactions fail with `tx_bad_auth` |

---

## A. Freighter Extension Issues

### Symptoms
- Users see: "Please install the Freighter wallet extension"
- Or: "Transaction declined — wrong network selected in Freighter"

### Diagnosis

```bash
# Check frontend network config
curl http://localhost:3000/api/config 2>/dev/null | jq '.network'
# Expected: "testnet" or "mainnet" matching deployment

# Check for network passphrase mismatch in recent errors
# Sentry query: message:"invalid network passphrase"
```

### Fixes

| Problem | Fix |
|---|---|
| User on wrong Freighter network | Direct user to switch Freighter to correct network (Settings → Network) |
| Freighter version too old | Direct user to update extension; check minimum version requirement |
| `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` wrong in env | See Section D (Deployment Config) |
| Freighter API change breaks our integration | See Section C (SDK Incompatibility) |

**User-facing message for network mismatch:**
```
Your Freighter wallet is connected to a different Stellar network.
Please open Freighter → Settings → Network and select [Testnet/Mainnet].
Reload the page after switching.
```

---

## B. Magic.link Issues

### Symptoms
- Users see: "Login failed", "Could not connect wallet"
- Sentry: `Magic SDK error: MALFORMED_RESPONSE`, `401 Unauthorized`

### Diagnosis

```bash
# Test Magic.link API key validity
curl -s "https://api.magic.link/v1/auth/user/public" \
  -H "X-Magic-Secret-Key: $MAGIC_API_KEY" \
  | jq '.status'
# Expected: "ok"

# If Magic.link is down, check status
curl -s https://status.magic.link/api/v2/status.json | jq '.status.description'
```

### Fixes

| Problem | Fix |
|---|---|
| `NEXT_PUBLIC_MAGIC_API_KEY` misconfigured | Update env and redeploy |
| Magic.link API key rotated/revoked | Re-generate key at dashboard.magic.link; update env |
| Magic.link service outage | Display fallback notice; direct users to Freighter as alternative |
| Session token expired | Users must re-authenticate — guide through logout/login flow |

**Fallback Communication:**
```
Email/passkey wallet login is temporarily unavailable.
You can still connect using the Freighter browser extension as an alternative.
Download Freighter at https://freighter.app
```

---

## C. SDK Incompatibility After Frontend Update

### Symptoms
- Transactions fail with a new error after a frontend deployment
- Sentry shows errors only starting from deployment time
- Error type: `InvalidTransaction`, `tx_insufficient_fee`, `tx_bad_format`

### Diagnosis

```bash
# Compare current frontend version with last known working version
curl http://localhost:3000 -I | grep X-Deployment-Version

# Check if @stellar/stellar-sdk version changed in recent deployment
cd frontend/elcarehub-app
git log -5 --oneline package-lock.json

# Check if Soroban XDR schema version changed
stellar --version  # Check CLI version used for deployment

# Run the contract error coverage validator
node scripts/contract-errors/validate-error-coverage.mjs
```

### Recovery — Rollback Frontend Deployment

If a recent deployment caused the issue:

```bash
# On Vercel: rollback to previous deployment
# Go to Vercel Dashboard → Deployments → select previous → Rollback

# Or: git revert the frontend change and redeploy
cd frontend/elcarehub-app
git revert <commit_hash> --no-commit
git commit -m "revert: rollback wallet compatibility regression"
git push origin main
```

### Preventing SDK Incompatibility

Key version pins that must match:
- `@stellar/stellar-sdk` in `frontend/elcarehub-app/package.json`
- `@stellar/stellar-sdk` in `indexer/package.json`
- `stellar-cli` version used in `scripts/deploy/`
- Contract WASM compiled with matching Soroban SDK

```bash
# Verify versions are consistent
node -e "
  const f = require('./frontend/elcarehub-app/package.json');
  const i = require('./indexer/package.json');
  console.log('Frontend SDK:', f.dependencies['@stellar/stellar-sdk']);
  console.log('Indexer SDK:', i.dependencies['@stellar/stellar-sdk']);
"
```

---

## D. Wrong Network/Passphrase Configuration

### Symptoms
- **All** transactions fail for all users simultaneously
- Error: `tx_bad_auth` or `network passphrase mismatch`
- Likely trigger: recent deployment with misconfigured env vars

```bash
# Check what network the frontend is using
curl -s http://localhost:3000/api/config | jq

# Cross-check against expected values
EXPECTED_PASSPHRASE="Test SDF Network ; September 2015"  # testnet
# or: "Public Global Stellar Network ; September 2015"  # mainnet

# Compare frontend STELLAR_NETWORK_PASSPHRASE vs contract's network
stellar rpc --rpc-url $STELLAR_RPC_URL getNetwork | jq '.passphrase'
```

### Fix

1. Update `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` in frontend deployment environment
2. Redeploy frontend (Vercel: push to main or manually redeploy)
3. Verify: attempt a transaction in the UI

**Also check:**
```bash
# Verify indexer network matches
curl http://localhost:4000/version | jq

# Verify contract deployed matches what frontend is pointing to
echo "Frontend contract: $NEXT_PUBLIC_CONTRACT_ID"
stellar contract invoke \
  --id "$NEXT_PUBLIC_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- version
# Expected: "1.1.0" (not an error)
```

---

## User-Facing Error Mapping

| Error | User Message | Internal Action |
|---|---|---|
| `USER_REJECTED_ERROR` | "Transaction was rejected in your wallet." | No action — user declined |
| `Freighter not installed` | "Please install the Freighter wallet extension." | Link to https://freighter.app |
| `network passphrase mismatch` | "Switch your wallet to [network]." | Fix env config |
| `tx_insufficient_fee` | "Transaction fee too low. Please try again." | Increase base fee |
| `tx_bad_seq` | "Please refresh the page and try again." | Sequence number stale |
| `Magic.link login failed` | "Email login is unavailable. Use Freighter instead." | Check Magic.link status |

---

## Verification After Fix

```bash
# 1. Verify network config is correct
stellar contract invoke \
  --id "$MARKETPLACE_CONTRACT_ID" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- is_paused
# Expected: false (no errors)

# 2. Run E2E tests against staging
cd frontend/elcarehub-app
NEXT_PUBLIC_E2E_MOCK_CHAIN=false npx playwright test --project=chromium

# 3. Check Sentry error rate returns to baseline after fix

# 4. Test with both wallets manually if possible
```

---

## Communication

```
[Status Page — Wallet Issues]
Some users may be unable to connect wallets or submit transactions
due to a compatibility issue. We are investigating.

If you use Freighter: ensure your wallet is set to [Testnet/Mainnet] and
the extension is updated to the latest version.

If you use email/passkey login: this feature is temporarily unavailable.
Use Freighter as an alternative.
```

---

## Post-Incident Review Template

```markdown
## Incident: Wallet Incompatibility — [Date]

**Duration:** [start] to [resolution]
**Wallet(s) affected:** [Freighter | Magic.link | Both]
**Root Cause:** [SDK version | env config | external service outage]
**Impact:** [N] users unable to submit transactions for [Y] minutes

**Action Items:**
- [ ] Pin @stellar/stellar-sdk to exact version in package.json
- [ ] Add Freighter version check to frontend startup
- [ ] Add E2E smoke test for wallet connection on every deployment
- [ ] Document minimum supported wallet versions in README
```

---

## Owner & Contacts

| Role | Contact | Escalation |
|---|---|---|
| **Primary:** Frontend Lead | frontend@elcarehub.xyz | Slack #alerts |
| **Secondary:** Backend Lead | backend-lead@elcarehub.xyz | For network config issues |
| **Magic.link Support** | support@magic.link | For account-level issues |

---

## Related Runbooks

- [Incorrect Deployment Configuration](./incorrect-deployment-config.md)
- [Contract Pause](./contract-pause.md)
