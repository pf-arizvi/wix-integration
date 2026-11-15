/** Machine error codes written to error_log.code (SPEC §8, plus guardrail codes). */
export type ErrorCode =
  | "missing_sku"
  | "unknown_sku"
  | "unmapped_courier"
  | "no_physical_lines"
  | "unknown_item_type"
  | "invalid_address"
  | "invalid_line"
  | "wix_api_error"
  | "mintsoft_api_error"
  | "mintsoft_rejected"
  | "missing_tracking"
  | "order_not_found"
  | "mintsoft_cancelled"
  | "order_cancelled"
  | "despatch_mismatch"
  | "despatch_payload_invalid"
  // Guardrails
  | "mintsoft_writes_disabled"
  | "mintsoft_client_not_allowed"
  | "mintsoft_client_mismatch"
  | "mintsoft_verify_failed"
  | "config_error";
