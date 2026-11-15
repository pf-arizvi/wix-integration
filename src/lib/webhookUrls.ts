/** Our own inbound webhook URLs, registered on each Mintsoft order via ConnectAction. */

export interface WebhookUrls {
  despatch: string;
  cancel: string;
}

export function webhookUrls(baseUrl: string, slug: string, token: string): WebhookUrls {
  const base = baseUrl.replace(/\/+$/, "");
  const q = `?token=${encodeURIComponent(token)}`;
  const s = encodeURIComponent(slug);
  return {
    despatch: `${base}/webhooks/mintsoft/despatch/${s}${q}`,
    cancel: `${base}/webhooks/mintsoft/cancel/${s}${q}`,
  };
}
