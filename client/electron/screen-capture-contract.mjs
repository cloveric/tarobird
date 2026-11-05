// Shared by main and the sandboxed capture preload; no imports, so the preload
// bundle never pulls Node modules into the sandbox.
export const CAPTURE_ORIGIN = 'tarobot-screen://capture';
export const CAPTURE_URL = `${CAPTURE_ORIGIN}/capture.html`;
export const CAPTURE_PORT_CHANNEL = 'tarobot-screen:port:v1';
export const CAPTURE_CSP = "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'";
