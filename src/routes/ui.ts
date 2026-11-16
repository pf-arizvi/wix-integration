/**
 * The admin page: GET /admin (+ /admin/app.css, /admin/app.js). Static; holds no data.
 * Data comes from the authenticated /admin/* JSON API. Cloudflare Access sits in front of /admin;
 * the API also verifies the Access login itself.
 */
import { ADMIN_CSS } from "../ui/css";
import { ADMIN_HTML } from "../ui/html";
import { ADMIN_JS } from "../ui/js";
import type { Handler } from "../router";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; " +
    "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};

function asset(body: string, type: string): Handler {
  return () => new Response(body, { headers: { "Content-Type": type, ...SECURITY_HEADERS } });
}

export const adminPageHandler = asset(ADMIN_HTML, "text/html; charset=utf-8");
export const adminCssHandler = asset(ADMIN_CSS, "text/css; charset=utf-8");
export const adminJsHandler = asset(ADMIN_JS, "text/javascript; charset=utf-8");
