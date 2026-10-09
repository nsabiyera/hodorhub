# Shared env-from-secret blocks are repeated per container (Cloud Run v2 has no
# shared env). Kept explicit for clarity.

# ── Web service (public, autoscaling, scale-to-zero-ish) ──────────────────────
resource "google_cloud_run_v2_service" "web" {
  name     = "hodorhub-web"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 1
      max_instance_count = var.web_max_instances
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }
    containers {
      image = var.image
      ports {
        container_port = 3000
      }
      resources {
        cpu_idle = true # web may idle-throttle between requests
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PUBLIC_BASE_URL"
        value = var.public_base_url
      }
      dynamic "env" {
        for_each = local.runtime_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_version.managed]
}

# Web is public.
resource "google_cloud_run_v2_service_iam_member" "web_public" {
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Worker service (always-on, internal, CPU always allocated) ────────────────
resource "google_cloud_run_v2_service" "worker" {
  name     = "hodorhub-worker"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 1 # always on for pg-boss + the outbox relay
      max_instance_count = 1
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }
    containers {
      image   = var.image
      command = ["node", "dist/worker.cjs"]
      resources {
        cpu_idle = false # CPU always allocated — poll loops/cron/relay keep running (A3)
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PUBLIC_BASE_URL"
        value = var.public_base_url
      }
      dynamic "env" {
        for_each = local.runtime_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_version.managed]
}

# ── Migration job (one-shot, run before each web rollout) ─────────────────────
resource "google_cloud_run_v2_job" "migrate" {
  name     = "hodorhub-migrate"
  location = var.region

  template {
    template {
      service_account = google_service_account.runtime.email
      max_retries     = 1
      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }
      containers {
        image   = var.image
        command = ["node", "dist/migrate.cjs"]
        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.managed["hodorhub-database-url"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_version.managed]
}

locals {
  runtime_secret_env = {
    DATABASE_URL       = google_secret_manager_secret.managed["hodorhub-database-url"].secret_id
    APP_ENCRYPTION_KEY = google_secret_manager_secret.managed["hodorhub-app-encryption-key"].secret_id
    SESSION_SECRET     = google_secret_manager_secret.managed["hodorhub-session-secret"].secret_id
    SMTP_PASSWORD      = google_secret_manager_secret.smtp_password.secret_id
  }
}
