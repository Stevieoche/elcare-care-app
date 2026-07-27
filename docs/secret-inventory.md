# ElcareHub Secret Inventory and Management

**Document Version:** 1.0  
**Last Updated:** 2026-07-27  
**Owner:** Security Team | ops@elcarehub.xyz

This document inventories all secrets, credentials, and environment variables used across ElcareHub's infrastructure, classifies their sensitivity, documents storage locations, and defines rotation procedures.

---

## Table of Contents

1. [Classification System](#classification-system)
2. [Indexer Secrets](#indexer-secrets)
3. [Frontend Secrets](#frontend-secrets)
4. [Deployment & CI/CD Secrets](#deployment--cicd-secrets)
5. [Third-Party Service Secrets](#third-party-service-secrets)
6. [Storage Requirements](#storage-requirements)
7. [Rotation Procedures](#rotation-procedures)
8. [Incident Response](#incident-response)
9. [Automated Checks](#automated-checks)

---

## Classification System

| Class | Description | Storage | Rotation Frequency | Example |
|---|---|---|---|---|
| **CRITICAL** | Provides admin control over funds, contract state, or user data | Secrets manager only; never in files | 90 days or on compromise | `ADMIN_SECRET`, `KEEPER_SECRET` |
| **SENSITIVE** | API keys that allow write operations, DB credentials | Secrets manager or encrypted env vars | 180 days or on compromise | `PINATA_JWT`, `DATABASE_URL`, `SENTRY_AUTH_TOKEN` |
| **OPERATIONAL** | Read-only credentials, non-sensitive config | Encrypted env vars or deployment platform | 365 days or on compromise | `REDIS_URL` (no auth), `NEXT_PUBLIC_STELLAR_RPC_URL` |
| **PUBLIC** | Identifiers safe to expose client-side | Plain text; version-controlled `.env.example` | Never (immutable) | `NEXT_PUBLIC_CONTRACT_ID`, `NEXT_PUBLIC_STELLAR_NETWORK` |

---

## Indexer Secrets

| Variable | Class | Purpose | Owner | Storage Location | Rotation Interval |
|---|---|---|---|---|---|
| `DATABASE_URL` | SENSITIVE | PostgreSQL connection with password | DevOps | Kubernetes Secret / Railway env | 180 days |
| `REDIS_URL` | OPERATIONAL | Redis connection (no auth in dev; auth in prod) | DevOps | Kubernetes Secret / Railway env | 365 days |
| `KEEPER_SECRET` | CRITICAL | Stellar secret key for keeper bot | Backend Lead | HashiCorp Vault / Cloud KMS | 90 days |
| `HEALTH_DETAILS_TOKEN` | SENSITIVE | Admin token for `/health/details` endpoint | DevOps | Kubernetes Secret | 180 days |
| `ADMIN_SECRET` | CRITICAL | Admin Stellar secret key (deployment only) | CTO | Hardware wallet / Vault | 90 days or immediate on leak |
| `ARCHIVAL_STELLAR_RPC_URL` | OPERATIONAL | Full-history RPC for backfill | DevOps | Plain env var | Never (public URL) |

### Notes
- **CRITICAL:** `KEEPER_SECRET` and `ADMIN_SECRET` must never appear in CI logs, Sentry, or Docker images
- `DATABASE_URL` contains password — always redact in logs (format: `postgresql://user:***@host/db`)
- Keeper account must be funded but is NOT the admin — a separate keypair

---

## Frontend Secrets

| Variable | Class | Purpose | Owner | Storage Location | Rotation Interval |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_CONTRACT_ID` | PUBLIC | Marketplace contract address | Backend Lead | `.env.example` (committed) | Never (immutable per network) |
| `NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ID` | PUBLIC | Launchpad contract address | Backend Lead | `.env.example` (committed) | Never |
| `NEXT_PUBLIC_STELLAR_NETWORK` | PUBLIC | Network name ("testnet" / "mainnet") | Backend Lead | `.env.example` (committed) | Never |
| `NEXT_PUBLIC_STELLAR_RPC_URL` | PUBLIC | Soroban RPC endpoint | DevOps | `.env.example` (committed) | Never (public endpoint) |
| `NEXT_PUBLIC_STELLAR_HORIZON_URL` | PUBLIC | Horizon API URL | DevOps | `.env.example` (committed) | Never |
| `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` | PUBLIC | Network passphrase | Backend Lead | `.env.example` (committed) | Never |
| `NEXT_PUBLIC_INDEXER_URL` | PUBLIC | Indexer API base URL | DevOps | `.env.example` (committed) | Never (deployment-specific) |
| `NEXT_PUBLIC_PINATA_GATEWAY` | PUBLIC | IPFS gateway URL | DevOps | `.env.example` (committed) | Never |
| `PINATA_JWT` | SENSITIVE | **Server-side only** Pinata upload API key | DevOps | Vercel env vars (encrypted) | 180 days |
| `NEXT_PUBLIC_MAGIC_API_KEY` | PUBLIC (write-only) | Magic.link publishable API key | Frontend Lead | `.env.example` (committed) | Never (not secret per Magic docs) |
| `NEXT_PUBLIC_SENTRY_DSN` | PUBLIC (write-only) | Sentry ingest endpoint | DevOps | `.env.example` (committed) | Never (public write token) |
| `SENTRY_ORG` | OPERATIONAL | Sentry organization slug | DevOps | Vercel env vars | Never |
| `SENTRY_PROJECT` | OPERATIONAL | Sentry project name | DevOps | Vercel env vars | Never |
| `SENTRY_AUTH_TOKEN` | SENSITIVE | **Server-side** Sentry source map upload token | DevOps | GitHub Secrets / Vercel | 180 days |
| `NEXT_PUBLIC_POSTHOG_KEY` | PUBLIC (write-only) | PostHog analytics key | Marketing | `.env.example` (committed) | Never (public write token) |

### Notes
- **NEVER** set Stellar secret keys (`S...`) in any `NEXT_PUBLIC_*` variable — they are embedded in client JS
- `PINATA_JWT` is server-side only — used in Next.js API routes `/api/ipfs/*`, never exposed to browser
- `SENTRY_AUTH_TOKEN` used only during build for source map uploads — not in runtime bundle

### Startup Validation

Frontend validates on `npm run build`:

```javascript
// Check NO secret patterns appear in NEXT_PUBLIC_ variables
const publicVars = Object.keys(process.env).filter(k => k.startsWith('NEXT_PUBLIC_'));
publicVars.forEach(key => {
  const val = process.env[key];
  if (/^S[A-Z0-9]{55}$/.test(val)) {
    throw new Error(`CRITICAL: Stellar secret key detected in ${key}. Aborting build.`);
  }
  if (/^eyJ/.test(val) && key !== 'NEXT_PUBLIC_SENTRY_DSN') {
    console.warn(`WARNING: JWT-like value in ${key}. Verify this is intentional.`);
  }
});
```

---

## Deployment & CI/CD Secrets

| Variable | Class | Purpose | Owner | Storage Location | Rotation Interval |
|---|---|---|---|---|---|
| `STELLAR_SECRET_KEY` | CRITICAL | Deployer Stellar secret (used in `deploy_contract.sh`) | CTO | GitHub Secrets (encrypted) | 90 days |
| `VERCEL_TOKEN` | SENSITIVE | Vercel API token for CLI deploys | DevOps | GitHub Secrets | 180 days |
| `DOCKER_HUB_TOKEN` | SENSITIVE | Docker registry push token | DevOps | GitHub Secrets | 180 days |
| `KUBECONFIG` | SENSITIVE | Kubernetes cluster admin config | DevOps | GitHub Secrets | 180 days |

### Notes
- Deployer `STELLAR_SECRET_KEY` is used only at contract deployment time, not at runtime
- **After initial deployment**, this key can be replaced with a new one for future upgrades
- CI secrets are encrypted by GitHub; rotation requires updating GitHub org/repo secrets

---

## Third-Party Service Secrets

| Service | Secret Type | Where Used | Class | Owner | Rotation |
|---|---|---|---|---|---|
| **Pinata** | JWT | Frontend (`PINATA_JWT`) | SENSITIVE | DevOps | 180 days; revoke in Pinata dashboard |
| **Sentry** | Auth Token | CI source map upload | SENSITIVE | DevOps | 180 days; regenerate in Sentry settings |
| **Sentry** | DSN | Frontend/indexer error ingestion | PUBLIC | DevOps | Never (write-only public token) |
| **PostHog** | API Key | Frontend analytics | PUBLIC | Marketing | Never (write-only) |
| **Magic.link** | Publishable Key | Frontend wallet login | PUBLIC | Frontend Lead | Never (public by design) |
| **Stellar RPC** | N/A | Public endpoint | PUBLIC | N/A | N/A |
| **PostgreSQL** | Password in `DATABASE_URL` | Indexer | SENSITIVE | DevOps | 180 days; rotate via provider console |
| **Redis** | Password (optional) | Indexer | OPERATIONAL | DevOps | 365 days |

### Rotation Steps by Service

#### Pinata JWT
1. Log in to [app.pinata.cloud](https://app.pinata.cloud) → API Keys
2. Revoke old key
3. Generate new JWT (same permissions)
4. Update `PINATA_JWT` in Vercel env vars
5. Redeploy frontend (`git push` or manual redeploy)
6. Test listing creation end-to-end

#### Sentry Auth Token
1. Log in to [sentry.io](https://sentry.io) → Settings → Auth Tokens
2. Revoke old token
3. Generate new token with `project:releases` scope
4. Update `SENTRY_AUTH_TOKEN` in GitHub Secrets
5. Next build will use new token

#### Database Password
1. Rotate password in managed DB provider (Railway / Supabase / RDS)
2. Copy new connection string
3. Update `DATABASE_URL` in deployment env (Railway / Kubernetes / Vercel)
4. Restart indexer
5. Verify `/health` returns ok

---

## Storage Requirements

### CRITICAL Secrets
- **MUST** be stored in a secrets manager: HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, or Azure Key Vault
- **MUST NOT** appear in:
  - `.env` files (even if .gitignore'd)
  - CI logs (mask in workflows)
  - Docker image layers (use runtime injection)
  - Sentry error reports (redact before sending)
- Access audited; MFA required for retrieval

### SENSITIVE Secrets
- **CAN** be stored in platform-provided encrypted environment variables (Vercel, Railway, Kubernetes Secrets)
- **MUST NOT** appear in version control
- Masked in CI logs via `::add-mask::` (GitHub Actions) or equivalent

### OPERATIONAL Secrets
- **CAN** be stored in deployment platform env vars
- **CAN** be documented in runbooks if redacted properly (e.g., `postgresql://user:***@host/db`)

### PUBLIC Values
- **CAN** be committed to `.env.example`
- **CAN** be embedded in client-side bundles
- **MUST** be verified as non-sensitive before classification

---

## Rotation Procedures

### Scheduled Rotation Cadence

| Frequency | Secret Class | Trigger |
|---|---|---|
| **Every 90 days** | CRITICAL | Calendar reminder; automated if using cloud KMS |
| **Every 180 days** | SENSITIVE | Calendar reminder |
| **Every 365 days** | OPERATIONAL | Opportunistic (during maintenance windows) |
| **On compromise** | ALL | Immediate |

### Emergency Rotation (Compromise Detected)

1. **Identify the scope:**  
   - Which secret was exposed?  
   - Where was it exposed? (git, logs, Sentry, chat)  
   - Who had access?

2. **Revoke immediately:**  
   - For Stellar keys: Rotate via 2-step admin transfer (see [compromised-admin-key.md](./runbooks/compromised-admin-key.md))  
   - For API keys: Revoke in service dashboard  
   - For DB passwords: Rotate via provider console

3. **Update all environments:**  
   - CI/CD secrets  
   - Deployment platform (Vercel, Railway, Kubernetes)  
   - Local developer `.env` files (instruct team via Slack)

4. **Verify rotation:**  
   - Test health endpoints  
   - Check Sentry for new auth errors  
   - Monitor logs for unexpected behavior

5. **Audit access logs:**  
   - Check who retrieved the secret from the secrets manager  
   - Review recent deployments for anomalies

6. **Document incident:**  
   - Use post-incident review template  
   - Update this inventory if new secrets were discovered

---

## Incident Response

### Secret Leaked in Git History

```bash
# 1. Revoke the exposed secret immediately (see Rotation Procedures above)

# 2. Remove from git history (requires force push — coordinate with team)
git filter-repo --path-glob '*.env' --invert-paths
git push --force origin main

# 3. Alert all contributors
# Slack: "@channel URGENT: Secrets leaked in git history. 
#         Do NOT push until you pull the cleaned history."

# 4. Invalidate all clones
# Each developer must re-clone or rebase onto cleaned history
```

### Secret Logged to Sentry

1. Open Sentry → issue → click "Delete Event"
2. Check Sentry breadcrumbs for any related events containing the secret
3. Rotate the secret immediately
4. Add redaction rule to Sentry: Settings → Security & Privacy → Advanced Data Scrubbing
   - Pattern: Regex matching the secret format (e.g., `S[A-Z0-9]{55}` for Stellar keys)

### Secret Logged to CI

1. Cancel the in-progress workflow run (prevents log from being fully committed)
2. Rotate the secret
3. Add masking to workflow file:
   ```yaml
   - name: Mask sensitive vars
     run: |
       echo "::add-mask::${{ secrets.ADMIN_SECRET }}"
       echo "::add-mask::${{ secrets.KEEPER_SECRET }}"
   ```
4. Purge workflow run logs if possible (GitHub: Settings → Actions → delete run)

---

## Automated Checks

### Pre-Commit Hook (Gitleaks)

Install locally:
```bash
# Install Gitleaks
brew install gitleaks  # macOS
# or download from https://github.com/gitleaks/gitleaks/releases

# Add to .git/hooks/pre-commit
#!/bin/bash
gitleaks protect --verbose --redact --staged
if [ $? -ne 0 ]; then
  echo "❌ Gitleaks detected secrets. Commit aborted."
  exit 1
fi
```

### CI Secret Scanning (.github/workflows/ci.yml)

Already enabled:
```yaml
secret-scan:
  name: Secret Scanning (Gitleaks)
  runs-on: ubuntu-latest
  steps:
    - name: Checkout Repository
      uses: actions/checkout@v4
      with:
        fetch-depth: 0  # Full history for Gitleaks
    - name: Run Gitleaks
      run: gitleaks detect --source . --redact --log-level warn
```

Fails the build if secrets are detected.

### Runtime Validation (Indexer Startup)

`indexer/src/startup-validation.ts`:
```typescript
export function validateSecrets() {
  const required = ['DATABASE_URL', 'KEEPER_SECRET', 'ADMIN_SECRET'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`CRITICAL: Missing secrets: ${missing.join(', ')}`);
  }

  // Validate Stellar secret key format
  ['KEEPER_SECRET', 'ADMIN_SECRET'].forEach(key => {
    const val = process.env[key];
    if (!/^S[A-Z0-9]{55}$/.test(val)) {
      throw new Error(`CRITICAL: ${key} is not a valid Stellar secret key format.`);
    }
  });

  // Validate DATABASE_URL contains password
  const dbUrl = process.env.DATABASE_URL!;
  if (!dbUrl.includes(':') || !dbUrl.includes('@')) {
    throw new Error('CRITICAL: DATABASE_URL appears malformed (missing password?)');
  }

  console.log('✅ Secret validation passed');
}
```

Called in `indexer/src/index.ts` before starting the server.

### Public/Private Boundary Check (Frontend Build)

`frontend/elcarehub-app/scripts/validate-env-boundary.js`:
```javascript
#!/usr/bin/env node
const NEXT_PUBLIC_PREFIX = 'NEXT_PUBLIC_';
const SENSITIVE_PATTERNS = [
  /^S[A-Z0-9]{55}$/,          // Stellar secret key
  /^eyJ[A-Za-z0-9_-]+\.eyJ/,  // JWT (but allow SENTRY_DSN)
];

Object.keys(process.env).forEach(key => {
  if (!key.startsWith(NEXT_PUBLIC_PREFIX)) return;
  const val = process.env[key];
  SENSITIVE_PATTERNS.forEach(pattern => {
    if (pattern.test(val)) {
      console.error(`❌ CRITICAL: Sensitive value in ${key}`);
      process.exit(1);
    }
  });
});
console.log('✅ NEXT_PUBLIC boundary check passed');
```

Run in `package.json`:
```json
{
  "scripts": {
    "build": "node scripts/validate-env-boundary.js && next build"
  }
}
```

---

## Secret Classification Checklist

When adding a new environment variable, classify it:

- [ ] **Does it contain a password, private key, or write-access token?** → CRITICAL or SENSITIVE
- [ ] **Can an attacker use it to modify data or spend funds?** → CRITICAL
- [ ] **Is it safe to log in Sentry or CI?** → If no, at least SENSITIVE
- [ ] **Is it used client-side?** → MUST be PUBLIC or moved server-side
- [ ] **Does it need rotation?** → Add to rotation schedule
- [ ] **Who owns it?** → Assign owner and document in this inventory
- [ ] **Where is it stored?** → Add to storage requirements section
- [ ] **Is it redacted in logs?** → Add redaction rule if needed

---

## Appendix: Secret Redaction Patterns

When logging or displaying environment values:

| Secret Type | Regex Pattern | Redaction Output |
|---|---|---|
| Stellar secret key | `S[A-Z0-9]{55}` | `S***` |
| JWT | `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` | `eyJ***` |
| Database URL | `postgresql://([^:]+):([^@]+)@(.+)` | `postgresql://$1:***@$3` |
| Redis URL | `redis://([^:]+):([^@]+)@(.+)` | `redis://$1:***@$3` |
| API Key (generic) | `[A-Za-z0-9_-]{32,}` | `***` (first 4 chars visible) |

---

## Post-Incident Review Template

```markdown
## Secret Exposure Incident — [Date]

**Secret Exposed:** [name of secret]
**Exposure Vector:** [git | CI logs | Sentry | user report]
**Time to Detection:** [minutes]
**Time to Rotation:** [minutes]

**Impact:**
- [ ] Was the secret used by an attacker? [Yes/No]
- [ ] Were user funds at risk? [Yes/No]
- [ ] Was data accessed or modified? [Yes/No]

**Root Cause:** [how the secret was exposed]

**Action Items:**
- [ ] Rotate affected secret (completed at [time])
- [ ] Add redaction rule to logging/monitoring
- [ ] Update .gitleaks.toml with new pattern if needed
- [ ] Notify affected users if data was accessed
- [ ] Schedule next secrets audit for [date]
```

---

## Owner & Review Schedule

| Responsibility | Owner | Frequency |
|---|---|---|
| **Inventory accuracy** | Security Team | Quarterly |
| **Rotation compliance** | DevOps | Per schedule above |
| **Incident response** | Security Team + CTO | On-demand |
| **Secrets manager access audit** | Security Team | Monthly |

**Next scheduled review:** [90 days from document date]

**Document change log:**  
- 2026-07-27: Initial version (v1.0)
