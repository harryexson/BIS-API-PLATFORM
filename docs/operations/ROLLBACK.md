# Rollback Procedures

> **CRITICAL SAFETY RULES:**
> - **NEVER** run `drizzle-kit push --force` on production
> - **NEVER** run `DROP TABLE`, `DELETE FROM`, or `TRUNCATE` on production databases
> - **NEVER** use `drizzle-kit migrate --force` to overwrite migrations
> - **NEVER** auto-destroy production database resources via CI/CD
> - All production database changes require human approval in the `production` environment

---

## 1. Code Rollback

### Railway (API Gateway + Worker)

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login

# List recent deployments
railway logs --service api-gateway

# Rollback to previous deployment
railway rollback --service api-gateway
railway rollback --service worker
```

### Vercel (Admin Console)

```bash
# Install Vercel CLI
npm install -g vercel
vercel login

# List recent deployments
vercel ls

# Rollback to previous deployment
vercel rollback --token $VERCEL_TOKEN
```

### GitHub Actions Rollback

```bash
# Trigger manual rollback via workflow dispatch
gh workflow run deploy.yml -f target=rollback
```

---

## 2. Database Rollback

### Forward Migration (Preferred)

The safest approach is to create a new migration that reverses the problematic change.

```bash
# 1. Identify the problematic migration
ls packages/database/drizzle/

# 2. Create a new migration that reverses the change
# Edit packages/database/src/schema/index.ts to reflect desired state

# 3. Generate the reverse migration
npm run drizzle:generate --workspace=@company/database

# 4. Review the generated SQL
cat packages/database/drizzle/0003_rollback_description.sql

# 5. Apply the migration
npm run drizzle:migrate --workspace=@company/database
```

### Neon Point-in-Time Recovery (PITR)

For catastrophic failures, use Neon's built-in PITR:

1. Go to Neon Dashboard → Project → Restore
2. Select a timestamp before the problematic change
3. Confirm the restore
4. Update `DATABASE_URL` if the endpoint changes

### Migration Validation

Always validate migrations before and after applying:

```bash
# Check schema matches code
npm run drizzle:check --workspace=@company/database

# Validate migration files exist
npm run drizzle:generate --workspace=@company/database
# Then check: drizzle-kit check
```

---

## 3. Emergency Procedures

### Scenario: Bad Migration Deployed

1. **Stop the bleeding**: Deploy previous code version (code rollback above)
2. **Assess damage**: Check Neon Dashboard for data integrity
3. **Fix forward**: Create reverse migration, not a `DROP`
4. **Validate**: Run `drizzle:check` to confirm schema alignment
5. **Deploy fix**: Push new migration through normal CI/CD pipeline

### Scenario: API Gateway Down

1. **Rollback code**: `railway rollback --service api-gateway`
2. **Verify health**: `curl https://api.company.com/health`
3. **Check logs**: `railway logs --service api-gateway`
4. **Escalate**: If persistent, check Neon database connectivity

### Scenario: Worker Stuck

1. **Scale down**: Railway dashboard → worker service → scale to 0
2. **Clear stuck jobs**: Redis `FLUSHDB` (only if safe for your workload)
3. **Rollback code**: `railway rollback --service worker`
4. **Scale up**: Railway dashboard → worker service → scale to 1+

---

## 4. Pre-Rollback Checklist

Before executing any rollback:

- [ ] Confirm the issue is reproducible
- [ ] Identify the exact commit/deployment that introduced the issue
- [ ] Notify team members in #incidents channel
- [ ] Capture current logs for post-mortem
- [ ] Verify backup exists (Neon automatic backups are enabled)
- [ ] Test rollback in staging if possible
- [ ] Document the rollback in incident tracker

---

## 5. Post-Rollback Actions

After rollback:

- [ ] Verify all services are healthy
- [ ] Run smoke tests against production
- [ ] Check error rates in monitoring
- [ ] Notify stakeholders of resolution
- [ ] Create incident report
- [ ] Schedule post-mortem if severity warrants
- [ ] Create follow-up task to fix root cause properly
