# Infrastructure (GCP, Terraform)

Provisions the HodorHub production estate per [ADR 0002](../docs/adr/0002-cloud-hosting-gcp.md): Cloud Run (web + always-on worker) + a migration Job, Cloud SQL (Postgres, backups + PITR), Artifact Registry, Secret Manager, and **Workload Identity Federation** for keyless GitHub Actions deploys.

> **Not applied from here.** These files are written but unvalidated against a live project (no credentials in this environment). Run `terraform plan` against a real project before trusting them.

## One-time bootstrap

```bash
gcloud auth application-default login
gcloud config set project <PROJECT_ID>

cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # edit project_id, github_repository, public_base_url
# (recommended) configure the GCS backend block in versions.tf first — state holds
# the generated DB password / encryption key.

terraform init
terraform apply    # first apply creates everything with the `placeholder` image
```

Then set the SMTP password (never in Terraform state):

```bash
echo -n "<smtp-password>" | gcloud secrets versions add hodorhub-smtp-password --data-file=-
```

## Wire up CI deploys

From `terraform output`, set in the GitHub repo:

| GitHub setting | Value |
|----------------|-------|
| Secret `GCP_WIF_PROVIDER` | `wif_provider` output |
| Secret `GCP_DEPLOY_SA` | `deployer_service_account` output |
| Variable `GCP_PROJECT` | your project id |
| Variable `GCP_REGION` | `europe-west2` |
| Variable `DEPLOY_ENABLED` | `true` |

`.github/workflows/deploy.yml` then authenticates via WIF (no keys), builds + pushes the image tagged with the commit SHA, runs the migration Job, and rolls out web + worker.

## Notes / deferred (see TECH_DEBT.md)

- **DB connection budget (A2):** `web_max_instances × DB_POOL_MAX + worker + migrate` must fit Cloud SQL `max_connections`. Add a pooler if scaling up.
- **Memorystore (Redis)** is not provisioned — the app has no Redis dependency yet (in-process rate limiter, cookie sessions, pg-boss queue). Add it (with a Serverless VPC connector) when the Redis-backed rate limiter / horizontal scale lands.
- **Cloud SQL** uses the managed connector (socket) with `ipv4_enabled`; private IP + VPC is a hardening follow-up.
- **Custom domains / TLS** (Enterprise branding, Release 2) map onto the web service later.
