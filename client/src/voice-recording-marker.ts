const recordedVoiceFiles = new WeakSet<object>();

/** Marks a File created by the App's own voice recorder. */
export function markRecordedVoiceFile(file: File): File {
  recordedVoiceFiles.add(file);
  return file;
}

export function isRecordedVoiceFile(file: object): boolean {
  return recordedVoiceFiles.has(file);
}
