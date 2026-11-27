declare module "*/generated/acknowledgements.json" {
  export type GeneratedAcknowledgementCategory = "npm" | "asset" | "vendored" | "desktop" | "android" | "ios";

  export interface GeneratedAcknowledgementEntry {
    id: string;
    name: string;
    category: GeneratedAcknowledgementCategory;
    repository: string;
    version: string;
    license: string;
    usage: string;
    location: string;
    licenseText?: string;
    licenseTextIndex?: number;
    noticeText?: string;
  }

  export interface GeneratedAcknowledgementsPayload {
    version: number;
    licenseTexts?: string[];
    entries: GeneratedAcknowledgementEntry[];
  }

  const payload: GeneratedAcknowledgementsPayload;
  export default payload;
}
