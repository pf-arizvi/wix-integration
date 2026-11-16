/**
 * Alerts for things a person must act on (agreed: held orders → arizvi@premiumfulfilment.co.uk).
 *
 * TODO: no email sender is configured yet (options: Cloudflare Email Routing, Resend, a Teams /
 * Power Automate webhook). Until then an alert is a structured `alert.*` log line (searchable in
 * Workers Logs) on top of the error_log row the flows already write (GET /admin/errors).
 * Plug a sender in here only. Alert text: order number, reason, SKUs — never customer details.
 */
import type { ErrorCode } from "../errorCodes";
import { log } from "../lib/log";

export interface HeldOrderAlert {
  client: string;
  wixOrderNumber: string;
  code: ErrorCode;
  message: string;
}

export async function alertHeldOrder(a: HeldOrderAlert): Promise<void> {
  log.warn("alert.held_order", { ...a });
}

export async function alertNeedsAttention(a: HeldOrderAlert): Promise<void> {
  log.error("alert.needs_attention", { ...a });
}
