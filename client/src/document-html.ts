import DOMPurify from "dompurify";

/** Only semantic reading content. No document styles, active content, automatic
 * external resources or attributes capable of navigating the App origin. */
export function documentHtml(html: string): string {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "del", "br", "hr", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "blockquote", "pre", "code", "sup", "sub", "a", "img"],
    ALLOWED_ATTR: ["href", "src", "alt", "colspan", "rowspan", "start"],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  if (fragment.querySelectorAll("*").length > 20_000) throw new Error("large");
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href) && !/^mailto:[^\s]+$/i.test(href)) link.removeAttribute("href");
    else { link.setAttribute("target", "_blank"); link.setAttribute("rel", "noopener noreferrer"); }
  }
  for (const img of fragment.querySelectorAll("img")) {
    if (!/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(img.getAttribute("src") ?? "")) img.removeAttribute("src");
    img.setAttribute("loading", "lazy"); img.setAttribute("decoding", "async");
  }
  const container = document.createElement("div"); container.append(fragment); return container.innerHTML;
}
