// The suite may be launched from a running Bot. Never let its injected routing
// variables redirect a test's temporary HOME/workspace to a real instance, or
// its file-permission flags override the test's sandbox assumptions.
// Individual tests can still set these explicitly after setup when exercising
// environment precedence or subprocess propagation.
for (const name of ["TAROBOT_MESSAGE_ID", "TAROBOT_HOST_DIR", "TAROBOT_STATE_DIR", "TAROBOT_INSTANCE", "TAROBOT_ACTIVE_TURN", "TAROBOT_ACTIVE_INSTANCE", "TAROBOT_ACTIVE_STATE_DIR", "CODEX_TELEGRAM_STATE_DIR", "CODEX_TELEGRAM_INSTANCE", "CCTB_LARK_STATE_DIR", "CCTB_LARK_INSTANCE", "TAROCUB_INSTANCE", "TAROBOT_ALLOW_ANY_FILE_PATH", "CCTB_LARK_ALLOW_ANY_FILE_PATH"]) {
  delete process.env[name];
}
// Never reuse the developer's model, endpoint or restart command in a fixture.
for (const name of Object.keys(process.env)) if (name.startsWith("ASR_")) delete process.env[name];
