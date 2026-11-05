/** Recognize Google's explicit sign-in rejection page. This does not assume
 * that every embedded-browser login is rejected. Returns where to
 * continue there: the Google page being signed in to, else the account page. */
export function googleSigninRejected(raw: string | undefined): { target: string } | undefined {
  let url: URL;
  try { url = new URL(raw ?? ""); } catch { return undefined; }
  if (url.origin !== "https://accounts.google.com" || url.username || url.password || !/^\/(v\d+\/)?signin\/rejected\/?$/.test(url.pathname)) return undefined;
  let target = "https://accounts.google.com/";
  try {
    // Only Google's own continue targets: a page cannot use this to send the person elsewhere.
    const next = new URL(url.searchParams.get("continue") ?? "");
    if (next.protocol === "https:" && !next.username && !next.password && (next.hostname === "google.com" || next.hostname.endsWith(".google.com")) && next.href.length <= 2048) target = next.href;
  } catch { /* no usable continue URL */ }
  return { target };
}
