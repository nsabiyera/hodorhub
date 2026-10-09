terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  # Configure a remote backend (GCS) before real use so state — which holds the
  # generated DB password / keys — is stored securely, not on a laptop.
  # backend "gcs" { bucket = "hodorhub-tfstate"; prefix = "prod" }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
