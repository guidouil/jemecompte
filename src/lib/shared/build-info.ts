export interface BuildInfo {
  schemaVersion: number;
  repository: string;
  commit: string | null;
  workingTree: 'clean' | 'modified' | 'unavailable';
  sourceInventory: string;
  sourceSha256: string | null;
  sourceFileCount: number;
  lockSha256: string | null;
  node: string | null;
  npm: string | null;
  origin: string | null;
  admissionDifficulty: number;
  builder: string;
  workflowRun: string | null;
  buildId: string;
}

export const buildInfo: BuildInfo = __JEMECOMPTE_BUILD_INFO__;
