/**
 * GitHub Enterprise Repository Provider
 *
 * Extends the GitHub provider with support for GitHub Enterprise Server
 * instances. Uses the same gh CLI with custom hostname configuration.
 */

import type { RepositoryCapabilities } from "./types.js";
import type { ProviderInfo, ParsedUrl, ConnectionTestResult } from "../../../types/providers.js";
import type { Config, GitHubEnterpriseConfig } from "../../../types/config.js";
import { GitHubRepositoryProvider, type GitHubProviderConfig } from "./github.js";

export class GitHubEnterpriseRepositoryProvider extends GitHubRepositoryProvider {
  // @ts-expect-error - We override the type property to be "github-enterprise" instead of "github"
  override readonly info: ProviderInfo & { type: "github-enterprise" };

  override readonly capabilities: RepositoryCapabilities = {
    forking: true,
    draftPRs: true,
    reviews: true,
    inlineComments: true,
    statusChecks: true,
    autoMerge: true,
    branchProtection: true,
    codeOwners: true,
    prTerminology: "pull_request",
  };

  private readonly enterpriseHost: string;
  private readonly enterpriseBaseUrl: string;

  constructor(
    config: Config,
    enterpriseConfig: GitHubEnterpriseConfig,
    providerConfig: GitHubProviderConfig = {}
  ) {
    // Extract hostname from baseUrl
    const url = new globalThis.URL(enterpriseConfig.baseUrl);
    const host = url.host;

    const superConfig: GitHubProviderConfig = {
      ...providerConfig,
      baseUrl: enterpriseConfig.baseUrl,
      apiUrl: enterpriseConfig.apiUrl ?? `${enterpriseConfig.baseUrl}/api/v3`,
    };
    if (enterpriseConfig.token) {
      superConfig.token = enterpriseConfig.token;
    }
    super(config, superConfig);

    this.enterpriseHost = host;
    this.enterpriseBaseUrl = enterpriseConfig.baseUrl;

    // Override the info property with enterprise-specific values
    (this as unknown as { info: ProviderInfo & { type: "github-enterprise" } }).info = {
      name: `GitHub Enterprise (${host})`,
      type: "github-enterprise",
      version: "1.0.0",
      baseUrl: enterpriseConfig.baseUrl,
    };
  }

  // === Availability ===

  override async isAvailable(): Promise<boolean> {
    try {
      // Check if gh is installed
      const ghAvailable = await super.isAvailable();
      if (!ghAvailable) {
        return false;
      }

      // Check if we're authenticated to this enterprise host
      const output = await this.runGh(["auth", "status", "--hostname", this.enterpriseHost]);
      return output.includes("Logged in");
    } catch {
      return false;
    }
  }

  override async testConnection(): Promise<ConnectionTestResult> {
    try {
      const user = await this.getCurrentUser();
      return {
        success: true,
        info: {
          user,
          host: this.enterpriseHost,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // === URL Handling ===

  override canHandleUrl(url: string): boolean {
    try {
      const parsed = new globalThis.URL(url);
      return parsed.host === this.enterpriseHost;
    } catch {
      return false;
    }
  }

  protected override isEnterpriseUrl(_url: string): boolean {
    // This IS the enterprise provider
    return true;
  }

  override parseUrl(url: string): ParsedUrl | null {
    if (!this.canHandleUrl(url)) {
      return null;
    }

    try {
      const parsed = new globalThis.URL(url);
      const pathParts = parsed.pathname.split("/").filter(Boolean);

      if (pathParts.length < 2) {
        return null;
      }

      const result: ParsedUrl = {
        provider: "github-enterprise",
        host: this.enterpriseHost,
        owner: pathParts[0]!,
        repo: pathParts[1]!.replace(/\.git$/, ""),
      };

      // Check for PR or issue
      if (pathParts.length >= 4) {
        if (pathParts[2] === "pull" && pathParts[3]) {
          result.resourceType = "pr";
          result.resourceId = parseInt(pathParts[3], 10);
        } else if (pathParts[2] === "issues" && pathParts[3]) {
          result.resourceType = "issue";
          result.resourceId = parseInt(pathParts[3], 10);
        }
      }

      return result;
    } catch {
      return null;
    }
  }

  override buildUrl(parsed: Omit<ParsedUrl, "provider" | "host">): string {
    let url = `${this.enterpriseBaseUrl}/${parsed.owner}/${parsed.repo}`;
    if (parsed.resourceType === "pr" && parsed.resourceId) {
      url += `/pull/${parsed.resourceId}`;
    } else if (parsed.resourceType === "issue" && parsed.resourceId) {
      url += `/issues/${parsed.resourceId}`;
    }
    return url;
  }

  // === Override gh commands to use enterprise hostname ===

  protected override runGh(args: string[]): Promise<string> {
    // Insert hostname flag for API calls and most operations
    const needsHostname = ["api", "pr", "issue", "repo", "auth"].some((cmd) => args[0] === cmd);

    if (needsHostname && !args.includes("--hostname")) {
      // Find the right position to insert hostname
      // For 'api' command, insert after 'api'
      // For others, append at end
      if (args[0] === "api") {
        args.splice(1, 0, "--hostname", this.enterpriseHost);
      } else {
        args.push("--hostname", this.enterpriseHost);
      }
    }

    return super.runGh(args);
  }

  override async getCurrentUser(): Promise<string> {
    // Use the enterprise hostname for auth status
    const output = await this.runGh(["auth", "status", "--hostname", this.enterpriseHost]);
    const match = output.match(/Logged in to .+ as (\S+)/);
    if (match?.[1]) {
      return match[1];
    }
    throw new Error(`Could not determine current user for ${this.enterpriseHost}`);
  }
}
