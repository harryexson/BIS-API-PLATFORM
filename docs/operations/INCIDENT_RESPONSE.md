# Incident Response

## Overview

This document defines how the platform responds to incidents: severity classification, roles and responsibilities, the incident lifecycle, communication templates, and the postmortem process.

Companion documents:
- [Monitoring Guide](./MONITORING.md) — alert rules and thresholds
- [Disaster Recovery](../architecture/DISASTER_RECOVERY.md) — failure scenario playbooks
- [Runbooks](./RUNBOOKS.md) — step-by-step recovery procedures

---

## Severity Classification

| Severity | Response Time | Impact | Examples |
|----------|---------------|--------|----------|
| **P1 Critical** | 15 minutes | Total service loss, data loss risk, or security incident | All payment providers unavailable, database unreachable, API key or credential compromise, data corruption |
| **P2 High** | 1 hour | Significant degradation affecting many clients | Single provider circuit open, error rate > 10%, p95 latency > 5s |
| **P3 Medium** | 4 hours | Partial degradation, non-critical | Stale pending transactions, single failed webhook batch, admin console degraded |
| **P4 Low** | Next business day | Cosmetic or non-urgent | Dashboard display issue, minor webhook processing delay |

**Escalation rule**: If an incident is not resolved within its severity response time, it escalates to the next severity level.

---

## Roles & Responsibilities

### On-Call Engineer (OCE)
- First responder for all alerts (PagerDuty)
- Triages, mitigates, and resolves incidents within scope
- Keeps the incident channel updated
- Escalates when unsure, stuck, or outside response time

### Incident Commander (IC)
- Appointed for any P1/P2 incident lasting > 30 minutes
- Owns the incident from end to end; sole decision maker
- Coordinates responders, comms, and escalation
- Approves any mitigation that risks data loss (e.g., DB restore)

### Communications Lead
- Posts status updates to the incident channel and status page
- Drafts customer-facing communications (with IC approval)
- Tracks "last update" cadence (every 15 min for P1)

### Subject Matter Experts (SMEs)
- Provider-specific knowledge (Stripe, Flutterwave, PawaPay, etc.)
- Database expertise for data issues
- Frontend expertise for admin console issues

---

## Escalation Matrix

| Alert | First Responder | Escalate To | Escalation Path |
|-------|-----------------|-------------|-----------------|
| All providers down (P1) | On-call engineer | Platform lead | PagerDuty on-call → Platform lead → CTO |
| DB unreachable (P1) | On-call engineer | Neon support | PagerDuty → Platform lead → Neon status page / support |
| Provider circuit open (P2) | On-call engineer | Provider SME | PagerDuty → Provider SME → Provider support ticket |
| Webhook failures (P3) | On-call engineer | — | Slack #platform-alerts → next-day review |
| Security incident (P1) | On-call engineer | Security lead immediately | PagerDuty → Security lead → legal/customer comms |

Contact channels:
- **PagerDuty**: P1/P2 alerts, on-call rotation
- **Slack**: `#platform-alerts` (all alerts), `#incidents` (active incident coordination)
- **Email**: `platform-ops@company.com` (async notifications, postmortems)

---

## Incident Lifecycle

```
Detect → Triage → Contain → Resolve → Monitor → Postmortem
```

### 1. Detect
- Alerts from monitoring (see [MONITORING.md](./MONITORING.md))
- Client-reported issues via `#support` or support email
- Provider status pages
- Manual dashboard observation

### 2. Triage (first 5 minutes)
On-call engineer answers these questions:
1. **What is affected?** Gateway, webhooks, worker, DB, provider, console?
2. **How severe?** Classify P1–P4 (table above).
3. **Is it ongoing or resolved?** Check current health endpoints.
4. **Do I need help?** If unsure → call for backup immediately.

Open the incident:
- Create a thread in `#incidents`: `[P1] All payment providers unavailable`
- For P1: activate PagerDuty escalation if more responders are needed
- Start the shared incident notes doc (link posted to thread)

### 3. Contain (stop the bleeding)
- Apply the relevant [Runbook](./RUNBOOKS.md) action
- Prefer **containment over fix**: e.g., disable a bad provider, revoke a key, pause a deploy
- Record every action taken with timestamps in the incident doc
- Never run destructive commands (restores, mass deletes) without IC approval

### 4. Resolve
- Verification criteria met (health checks pass, metrics recovered, transactions flowing)
- Announce resolution in the incident thread
- Update the status page

### 5. Monitor (post-resolution window)
- Keep watching key metrics for 30 minutes after resolution
- Watch specifically: error rate, circuit breaker states, webhook lag
- Confirm no regression before closing the incident

### 6. Postmortem
- Blameless review within **3 business days** for P1/P2
- See Postmortem Process below

---

## Communication Templates

### Internal Incident Start (Slack)
```
[P1] <summary>
Impact: <what is affected and how>
Severity: <P1–P4>
Started: <time>
Responders: <names>
Status: Investigating | Contained | Resolved
Next update: <time +15min>
```

### Status Update
```
Status: <unchanged | contained | resolved>
What we know: <2–3 bullet points>
What we're doing: <current mitigation>
Estimated resolution: <time or "not yet known">
```

### Resolution Message
```
[RESOLVED] <summary>
Duration: <start – end>
Root cause: <one-liner>
Mitigation applied: <what changed>
Next steps: <postmortem / follow-up item>
```

---

## Severity Checklists

### P1 Checklist
- [ ] On-call engineer acknowledged within 15 minutes
- [ ] Incident thread created in `#incidents`
- [ ] IC appointed (if > 30 min)
- [ ] Status page marked "Major Outage" (if customer-facing impact)
- [ ] PagerDuty escalation triggered for additional responders
- [ ] Timeline log started in incident doc
- [ ] Provider/dependency status pages checked
- [ ] Customer comms drafted if impact > 15 min

### P2 Checklist
- [ ] On-call engineer acknowledged within 1 hour
- [ ] Incident thread created
- [ ] Affected scope identified (which providers/apps/currencies)
- [ ] Mitigation in progress or complete
- [ ] Post-resolution monitoring confirmed

### P3/P4 Checklist
- [ ] Triaged and tracked in the incidents board
- [ ] P3: addressed same day; P4: next business day
- [ ] No customer comms required (unless requested)

---

## Security Incidents

A security incident follows the same lifecycle with additional requirements:

1. **Contain first, analyze second**: revoke keys, rotate credentials, isolate traffic
2. **Preserve evidence**: DB dumps, logs, webhook payloads — do not delete
3. **Notify**: security lead immediately, then platform lead; customer/legal comms per severity
4. **Audit trail**: every investigation action logged with timestamp and actor
5. **Postmortem**: mandatory, includes timeline, blast radius, and prevention items

See [DISASTER_RECOVERY.md](../architecture/DISASTER_RECOVERY.md) Scenario 6 for the API key compromise playbook.

---

## Postmortem Process

Every P1 and P2 incident gets a blameless postmortem within 3 business days.

### Postmortem Document Structure
```markdown
# Postmortem: <incident ID>

## Summary
<one paragraph: what happened, when, impact>

## Impact
<metrics: duration, error rate, affected clients, $ impact if known>

## Timeline (UTC)
<all events: detection, actions, escalations, resolution>

## Root Cause
<technical explanation, 5-whys>

## What Went Well
<list>

## What Went Wrong
<list>

## Action Items
| # | Action | Owner | Due | 
|---|--------|-------|-----|
| 1 | <fix, test, doc, alert> | <name> | <date> |
```

### Postmortem Rules
- No blame: "process failed" not "person failed"
- Every action item has an owner and due date
- Action items tracked to completion in the project board
- Follow-ups re-reviewed at the next on-call handover

---

## On-Call Handover

At each rotation change, the outgoing engineer provides:
- Open incidents and their status
- Known ongoing issues / provider quirks
- Recent changes (deploys, config, provider credentials)
- Outstanding postmortem action items
- Anything the next engineer should watch

---

## Related Procedures
- [Deployment Guide](./DEPLOYMENT.md) — rollback procedures
- [Runbooks](./RUNBOOKS.md) — step-by-step recovery steps
- [Disaster Recovery](../architecture/DISASTER_RECOVERY.md) — RTO/RPO and failure playbooks
