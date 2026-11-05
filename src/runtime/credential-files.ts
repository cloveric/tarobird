const CREDENTIAL_FILE_NAME_PATTERNS: RegExp[] = [
  /(?:^|\.)env(?:\.|$)/i,
  /^id_(?:rsa|ed25519|ecdsa|dsa)(?:_sk)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|keychain(?:-db)?|kdbx)$/i,
  /^\.(?:netrc|npmrc|pypirc|git-credentials|dockercfg|credentials\.(?:json|ya?ml))$/i,
];

// These are credential locations, not blanket bans on agent/config folders:
// generated images and ordinary reports inside those directories remain usable.
// Both separators are recognized regardless of the host doing the preflight.
const CREDENTIAL_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)\.codex\/auth\.json$/i,
  /(?:^|\/)\.kimi-code\/(?:config\.toml|credentials\/[^/]+\.json)$/i,
  /(?:^|\/)\.aws\/(?:credentials|sso\/cache\/[^/]+\.json)$/i,
  /(?:^|\/)gh\/hosts\.ya?ml$/i,
  /(?:^|\/)gcloud\/(?:application_default_credentials\.json|credentials\.db|access_tokens\.db)(?:-wal|-shm)?$/i,
  /(?:^|\/)\.docker\/config\.json$/i,
  /(?:^|\/)(?:chrome|chromium|edge|brave-browser)\/(?:user data\/)?[^/]+\/(?:network\/)?(?:cookies|login data|web data)(?:-wal|-shm|-journal)?$/i,
  /(?:^|\/)(?:firefox|mozilla)\/(?:profiles\/)?[^/]+\/(?:cookies\.sqlite|key[34]\.db|logins\.json)(?:-wal|-shm)?$/i,
  /(?:^|\/)library\/cookies\/cookies\.binarycookies$/i,
];

export function isCredentialStyleFileName(fileName: string): boolean {
  return CREDENTIAL_FILE_NAME_PATTERNS.some((pattern) => pattern.test(fileName));
}

export function isCredentialStylePath(...filePaths: Array<string | undefined>): boolean {
  return filePaths.some((filePath) => {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, "/");
    return isCredentialStyleFileName(normalized.slice(normalized.lastIndexOf("/") + 1))
      || CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
  });
}
