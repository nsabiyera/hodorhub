variable "project_id" {
  type        = string
  description = "GCP project id."
}

variable "region" {
  type        = string
  description = "GCP region (UK data residency)."
  default     = "europe-west2"
}

variable "github_repository" {
  type        = string
  description = "owner/repo allowed to deploy via Workload Identity Federation."
}

variable "image" {
  type        = string
  description = "Container image to deploy (Artifact Registry). Overridden per deploy with the commit SHA tag."
  default     = "placeholder"
}

variable "public_base_url" {
  type        = string
  description = "Public base URL of the neutral marketplace (OG tags, links, cookies)."
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL machine tier (comfortable tier ~ small dedicated)."
  default     = "db-custom-1-3840"
}

variable "db_ha" {
  type        = bool
  description = "Regional HA for Cloud SQL (defer to the $500+ tier; backups are always on)."
  default     = false
}

variable "web_max_instances" {
  type    = number
  default = 4
}
