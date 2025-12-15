/**
 * B2B Module
 *
 * Enterprise features for internal repository support.
 */

// Campaigns
export {
  CampaignService,
  CampaignRunner,
  createDryRunProcessor,
  type IssueProcessor,
  type CampaignRunnerEvent,
  type CampaignRunnerEventHandler,
} from "./campaigns/index.js";
