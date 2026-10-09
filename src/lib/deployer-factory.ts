import type { DeployerClient } from './deployer';
import { FakeDeployer } from './fake-deployer';

/**
 * Selects the DeployerClient named by AGENT_DELIVERY_DEPLOYER. 'fake' is
 * deterministic/offline; 'cloudrun' deploys the delivered app to a real,
 * per-app Cloud Run service via the privileged deployer identity. Throws
 * for any other name — a run must never deploy "for free" on a fake while
 * the operator believes real infra ran (mirrors getModelProvider).
 */
export function getDeployer(name: string): DeployerClient {
  if (name === 'fake') return new FakeDeployer();
  if (name === 'cloudrun') {
    // Real CloudRunDeployer needs a real ArtifactStore + GCP deploy client — Plan B2.
    throw new Error(
      'deployer "cloudrun" is not wired yet (Plan B2: real ArtifactStore + GCP deploy client)',
    );
  }
  throw new Error(`deployer "${name}" is not configured`);
}
