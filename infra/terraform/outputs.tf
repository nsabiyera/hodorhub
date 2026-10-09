output "web_url" {
  description = "Public URL of the web service."
  value       = google_cloud_run_v2_service.web.uri
}

output "artifact_registry" {
  description = "Docker image path prefix."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "cloudsql_connection_name" {
  value = google_sql_database_instance.main.connection_name
}

# ── GitHub Actions deploy secrets/vars ────────────────────────────────────────
output "wif_provider" {
  description = "Set as the GH secret GCP_WIF_PROVIDER."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deployer_service_account" {
  description = "Set as the GH secret GCP_DEPLOY_SA."
  value       = google_service_account.deployer.email
}
