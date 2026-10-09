# ── Enabled APIs ──────────────────────────────────────────────────────────────
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudscheduler.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ── Artifact Registry (container images) ──────────────────────────────────────
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "hodorhub"
  format        = "DOCKER"
  description   = "HodorHub container images"
  depends_on    = [google_project_service.apis]
}

# ── Service accounts ──────────────────────────────────────────────────────────
# Runtime SA the Cloud Run services + job run as (least privilege).
resource "google_service_account" "runtime" {
  account_id   = "hodorhub-runtime"
  display_name = "HodorHub runtime (Cloud Run)"
}

# Deploy SA impersonated by GitHub Actions via WIF (keyless).
resource "google_service_account" "deployer" {
  account_id   = "hodorhub-deployer"
  display_name = "HodorHub CI deployer"
}

# Runtime: connect to Cloud SQL.
resource "google_project_iam_member" "runtime_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# Deployer: manage Cloud Run, push images, and act as the runtime SA.
resource "google_project_iam_member" "deployer_run" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}
resource "google_project_iam_member" "deployer_ar" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}
resource "google_service_account_iam_member" "deployer_actas_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
