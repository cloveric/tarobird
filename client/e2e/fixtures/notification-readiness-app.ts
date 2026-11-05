import { plugins } from "./notification-readiness-core.js";
/** Uses the fixture's plugin table; the real package would be pre-bundled with
 * a private copy of the aliased core and never see `plugins.App`. */
export const App = new Proxy({}, { get: (_target, key: string) => (...args: unknown[]) => plugins.App?.[key]?.(...args) ?? Promise.reject({ code: "UNIMPLEMENTED" }) }) as any;
