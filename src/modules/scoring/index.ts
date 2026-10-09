/** Public interface of the Scoring bounded context. */
export {
  computeSupportScore,
  decayFactor,
  capSources,
  computeScores,
  applyScores,
  getScore,
  type Contribution,
} from './service';
