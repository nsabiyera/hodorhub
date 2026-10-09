# ── Generated secrets (held in TF state — use a secure GCS backend) ───────────
resource "random_password" "db" {
  length  = 32
  special = false
}
resource "random_id" "enc_key" {
  byte_length = 32 # → 32-byte AES-256 key (base64)
}
resource "random_password" "session" {
  length  = 48
  special = false
}

# ── Cloud SQL (Postgres) with automated backups + PITR ────────────────────────
resource "google_sql_database_instance" "main" {
  name                = "hodorhub-pg"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true

  settings {
    tier              = var.db_tier
    availability_type = var.db_ha ? "REGIONAL" : "ZONAL"
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
    }
    ip_configuration {
      ipv4_enabled = true # Cloud Run reaches it via the managed Cloud SQL connector (socket)
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  name     = "hodorhub"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  name     = "hodorhub"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}

# ── Secrets ───────────────────────────────────────────────────────────────────
locals {
  # Cloud Run mounts the Cloud SQL socket at /cloudsql/<connection_name>.
  database_url = "postgres://${google_sql_user.app.name}:${random_password.db.result}@/hodorhub?host=/cloudsql/${google_sql_database_instance.main.connection_name}"

  managed_secrets = {
    "hodorhub-database-url"       = local.database_url
    "hodorhub-app-encryption-key" = random_id.enc_key.b64_std
    "hodorhub-session-secret"     = random_password.session.result
  }
}

resource "google_secret_manager_secret" "managed" {
  for_each  = local.managed_secrets
  secret_id = each.key
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "managed" {
  for_each    = local.managed_secrets
  secret      = google_secret_manager_secret.managed[each.key].id
  secret_data = each.value
}

# SMTP password: container created here; set the value out-of-band (never in TF).
resource "google_secret_manager_secret" "smtp_password" {
  secret_id = "hodorhub-smtp-password"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# Runtime SA can read every app secret.
resource "google_secret_manager_secret_iam_member" "runtime_reads_managed" {
  for_each  = google_secret_manager_secret.managed
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
resource "google_secret_manager_secret_iam_member" "runtime_reads_smtp" {
  secret_id = google_secret_manager_secret.smtp_password.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
