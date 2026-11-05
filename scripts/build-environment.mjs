/** Preparation and dependency hooks do not need updater signing secrets.
 * The final signing stage remains part of the trusted release chain. */
export function preparationEnvironment(environment = process.env) {
  const copy = { ...environment };
  for (const key of Object.keys(copy)) {
    if (/^(TAURI_SIGNING_PRIVATE_KEY(?:_PATH|_PASSWORD)?|APPLE_(?:PASSWORD|ID|API_KEY.*|CERTIFICATE.*|NOTARY_PRIVATE_KEY))$/i.test(key)) delete copy[key];
  }
  return copy;
}
