export type AcknowledgementCategory = "asset" | "vendored" | "npm" | "desktop" | "android" | "ios";

export interface AcknowledgementEntry {
  id: string;
  name: string;
  category: AcknowledgementCategory;
  repository: string;
  version: string;
  license: string;
  usage: string;
  location: string;
  licenseText: string;
  noticeText?: string;
}

export interface BuiltAcknowledgements {
  version: number;
  entries: AcknowledgementEntry[];
  curatedCount: number;
  npmCount: number;
}

export function normalizeRepoUrl(repo: string | { url?: string } | null | undefined): string;
export function buildAcknowledgements(rootDir: string): BuiltAcknowledgements;
export function serializeAcknowledgementsPayload(built: BuiltAcknowledgements): string;
export function renderLicensingTable(curatedEntries: AcknowledgementEntry[], eol?: string): string;
export function updateLicensingMarkdown(currentText: string, curatedEntries: AcknowledgementEntry[]): string;
export function runCli(argv?: string[]): number;
