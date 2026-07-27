# Tabletop Exercises

Tabletop exercises test operational readiness by simulating incidents in a low-risk discussion format.  
No live systems are modified during a tabletop exercise.

**Schedule:** Quarterly  
**Duration:** 60-90 minutes per session  
**Format:** Facilitator presents a scenario; participants walk through detection, containment, and recovery steps using runbooks

---

## Participant Roles

| Role | Responsibility |
|---|---|
| **Facilitator** | Presents scenario; injects complications; keeps time |
| **Incident Commander** | Owns the response; makes decisions |
| **Backend Lead** | Contract/indexer expert; advises on data safety |
| **DevOps Engineer** | Executes infrastructure commands |
| **Frontend Lead** | Owns user communication; advises on wallet/UI |
| **Security Lead** | Advises on key management and disclosure |
| **Observer** | Takes notes; identifies runbook gaps |

---

## Exercise 1: "Stalled Indexer" — Completed 2026-07-27

**Scenario:** At 14:32 UTC, Prometheus fires an alert: `indexer_stalled == 1`. The on-call engineer opens the `/health` endpoint and sees `sync_lag: down`. No new listings have appeared in the UI for 8 minutes.

**Facilitator Injections:**
- T+5min: "The Stellar testnet RPC is returning 429 rate-limit errors"
- T+15min: "A user tweets they can't see their listing after creating it 10 minutes ago"
- T+25min: "Switching to the backup RPC resolves rate limiting, but sync lag is still 180 ledgers"

**Walk-Through:**

| Step | Runbook Used | Finding |
|---|---|---|
| Detection | [stalled-ingestion.md §Detection](./stalled-ingestion.md) | Alert fired correctly via `indexer_stalled` gauge |
| RPC diagnosis | stalled-ingestion.md §A | Identified 429 rate-limit error; switched RPC |
| Verify lag recovery | stalled-ingestion.md §Verification | 180 ledger lag persisted — identified need for gap-repair |
| User comms | stalled-ingestion.md §Communication | Template used verbatim; approved |
| Gap repair trigger | stalled-ingestion.md §Prevention | GAP_REPAIR_ENABLED=false — identified as config gap |

**Findings and Action Items:**
- [ ] **HIGH:** GAP_REPAIR_ENABLED is false by default. Enable for production deployments.
- [ ] **MEDIUM:** Fallback RPC switching is manual. Add `STELLAR_RPC_FALLBACK_URL` support.
- [ ] **LOW:** The 180-ledger lag is within `SYNC_LAG_DOWN` threshold (1000) but not `SYNC_LAG_DEGRADED` (100). Update alert thresholds.
- [x] **DONE:** Confirmed `POLL_INTERVAL_MS` can be changed without restart (env var hot-reload via TODO).

**Time to Identify Root Cause:** 12 minutes  
**Time to Apply Fix:** 22 minutes  
**Pass/Fail:** PASS — team identified correct runbook steps, but noted configuration gaps

**Signed off:** Security Lead, Backend Lead, DevOps Engineer  
**Date:** 2026-07-27

---

## Exercise Template (Blank)

**Date:** ___________  
**Facilitator:** ___________  
**Participants:** ___________

**Scenario:** [Describe the incident, including which component failed, what signals fired, and what users experienced]

**Facilitator Injections:**
- T+Xmin: [complication to inject]
- T+Ymin: [escalation]

**Walk-Through Table:**

| Step | Runbook Used | Finding |
|---|---|---|
| Detection | | |
| Containment | | |
| Root cause diagnosis | | |
| Recovery | | |
| Communication | | |
| Post-recovery verification | | |

**Findings and Action Items:**
- [ ] HIGH: ...
- [ ] MEDIUM: ...
- [ ] LOW: ...

**Time to Identify Root Cause:** ___ minutes  
**Time to Apply Fix:** ___ minutes  
**Pass/Fail:** ___

**Signed off:** ___  
**Date:** ___

---

## Planned Exercise Scenarios

| Scenario | Assigned Runbook | Scheduled Date | Status |
|---|---|---|---|
| Stalled Indexer | stalled-ingestion.md | 2026-07-27 | ✅ Completed |
| Deep Chain Reorg | reorganization.md | 2026-10-01 | Pending |
| Database Outage | database-outage.md | 2026-10-01 | Pending |
| Admin Key Compromise | compromised-admin-key.md | 2026-10-01 | Pending |
| Contract Pause (Exploit) | contract-pause.md | 2027-01-01 | Pending |
| Pinata Outage | pinata-outage.md | 2027-01-01 | Pending |
| Wallet Incompatibility | wallet-incompatibility.md | 2027-01-01 | Pending |
| Secret Leaked in Git | secret-inventory.md | 2027-01-01 | Pending |

---

## Runbook Gap Tracking

Issues discovered during tabletop exercises that require runbook updates:

| Issue | Runbook | Priority | Status |
|---|---|---|---|
| GAP_REPAIR_ENABLED=false default not documented as production risk | stalled-ingestion.md | HIGH | Open |
| No fallback RPC failover procedure | stalled-ingestion.md | MEDIUM | Open |
| Sync lag alert threshold (100 vs 1000 ledger difference not explained) | stalled-ingestion.md | LOW | Open |

---

## Escalation Contacts

| Contact | Role | Phone | Slack Handle | Available |
|---|---|---|---|---|
| Security Lead | Incident Owner | [REDACTED] | @security-lead | 24/7 on-call |
| Backend Lead | Technical Lead | [REDACTED] | @backend-lead | Business hours; paged for P1 |
| DevOps Engineer | Infrastructure | [REDACTED] | @devops | 24/7 on-call |
| Frontend Lead | User Comms | [REDACTED] | @frontend-lead | Business hours |
| CTO | Executive Escalation | [REDACTED] | @cto | P0/P1 only |
| Legal | Compliance | [REDACTED] | @legal | Funds-at-risk incidents |

**Escalation path:**

```
P3 (Degraded service) → DevOps or Backend Lead (business hours only)
P2 (Service unavailable) → On-call DevOps + Backend Lead
P1 (Funds at risk, data breach) → Incident Commander + CTO within 15 minutes
P0 (Active exploit, admin key compromised) → Full incident response team immediately
```
