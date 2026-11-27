import { exportAttachment } from "./attachment-export.js";

/** Saves a project backup through the App's ordinary file export, under the
 * name "Back up project" uses. Resolves false when the user dismissed the save
 * dialog. Used where no editor exists to do it: a Baoyu canvas kept from 1.6.0
 * or earlier, on its Tab and in Workbench files. */
export function saveDesignBackup(backup: string, title: string): Promise<boolean> {
  return exportAttachment(new Blob([backup], { type: "application/json" }), `${title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")}.tarobot-design.json`);
}
