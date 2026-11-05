// A local, user-only browsing space. Never a Host conversation or Bot target.
export const PERSONAL_BROWSER_SCOPE = Object.freeze({ host: "tarobot-personal-browser-v1", user: "local", conversation: "personal" });
// Four workbench panes plus the independent personal browser dock.
export const MAX_BROWSER_SURFACES = 5;
