export interface Project {
  id: string;
  url: string;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  language: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  topics: string[];
  license: string | null;
  defaultBranch: string;
  lastActivityAt: Date;
  hasContributingGuide: boolean;
  automatedTools: AutomatedTool[];
}

export type AutomatedTool =
  | "sourcery"
  | "codeclimate"
  | "sonarcloud"
  | "codecov"
  | "coveralls"
  | "deepsource"
  | "codacy"
  | "coderabbit"
  | "gitguardian"
  | "snyk"
  | "dependabot"
  | "renovate"
  | "pre-commit-ci"
  | "github-actions-lint"
  | "circleci"
  | "travisci";

export interface ProjectScore {
  total: number;
  breakdown: {
    responseTime: number;
    mergeRate: number;
    communityHealth: number;
    documentationQuality: number;
    automatedFeedback: number;
  };
}
