/**
 * Campaigns Module
 *
 * Campaign management for batch operations on issues.
 */

export { CampaignService } from "./campaign-service.js";
export {
  CampaignRunner,
  createDryRunProcessor,
  type IssueProcessor,
  type CampaignRunnerEvent,
  type CampaignRunnerEventHandler,
} from "./campaign-runner.js";
