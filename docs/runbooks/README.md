# ElcareHub Operational Runbooks

This directory contains incident response runbooks for ElcareHub's critical failure modes.  
Each runbook covers: detection, containment, diagnosis, recovery, and post-incident review.

---

## Index

| Runbook | Incident Type | Severity |
|---|---|---|
| [stalled-ingestion.md](./stalled-ingestion.md) | Indexer stops processing new ledgers | HIGH |
| [reorganization.md](./reorganization.md) | Stellar chain reorg detected | MEDIUM–HIGH |
| [database-outage.md](./database-outage.md) | PostgreSQL unavailable | CRITICAL |
| [redis-outage.md](./redis-outage.md) | Redis cache unavailable | MEDIUM |
| [compromised-admin-key.md](./compromised-admin-key.md) | Admin Stellar key exposed or stolen | CRITICAL |
| [contract-pause.md](./contract-pause.md) | Emergency pause / unpause procedure | CRITICAL |
| [pinata-outage.md](./pinata-outage.md) | Pinata/IPFS unavailable | MEDIUM |
| [wallet-incompatibility.md](./wallet-incompatibility.md) | Freighter or Magic.link failures | HIGH |
| [incorrect-deployment-config.md](./incorrect-deployment-config.md) | Wrong contract ID, network, or secrets | HIGH |
| [tabletop-exercises.md](./tabletop-exercises.md) | Exercise records and scenarios | — |

**Secret inventory:** [../secret-inventory.md](../secret-inventory.md)  
**Existing incident runbook:** [../INCIDENT_RUNBOOK.md](../INCIDENT_RUNBOOK.md) (contract pause, key rotation, keeper)

---

## Severity Levels

| Level | Description | Response Time |
|---|---|---|
| **CRITICAL** | Funds at risk; contract compromised; full outage | < 5 minutes |
| **HIGH** | Service degraded; users blocked from transacting | < 15 minutes |
| **MEDIUM** | Partial degradation; workaround available | < 30 minutes |
| **LOW** | Minor UX issue; monitoring gap | Next business day |

---

## First Response Quick Reference

**Contract paused unexpectedly?**  
→ [contract-pause.md](./contract-pause.md) — verify admin key; check `is_paused`

**Indexer not advancing?**  
→ [stalled-ingestion.md](./stalled-ingestion.md) — check RPC, DB, logs

**All transactions failing?**  
→ [wallet-incompatibility.md](./wallet-incompatibility.md) — check network passphrase and contract IDs first

**Admin key potentially leaked?**  
→ [compromised-admin-key.md](./compromised-admin-key.md) — pause immediately, then rotate

**No NFT images loading?**  
→ [pinata-outage.md](./pinata-outage.md) — check Pinata status, swap gateway

**Chain reorg logged?**  
→ [reorganization.md](./reorganization.md) — classify depth; most are auto-resolved

**Database returns 503?**  
→ [database-outage.md](./database-outage.md) — check container, pool, disk

---

## Versioning

Runbooks follow the project version in `versions.toml`.  
**Current version:** 1.0.0  
**Runbooks last updated:** 2026-07-27

Each runbook includes a post-incident review template. Completed reviews are stored in `docs/incidents/YYYY-MM-DD-<type>.md`.

---

## Contributing

1. Update the runbook when the system changes
2. Complete the post-incident review template after every real incident
3. Use tabletop exercises to validate runbooks quarterly
4. Update escalation contacts in [tabletop-exercises.md](./tabletop-exercises.md) when team changes
