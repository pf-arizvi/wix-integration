#!/usr/bin/env bash
# Import a client's Wix products into Mintsoft, one page per request, until done.
#
#   scripts/import-products.sh <client-slug>                 # DRY RUN (default): shows what would be created
#   scripts/import-products.sh <client-slug> --apply         # creates products (needs MINTSOFT_WRITES_ENABLED="true")
#   scripts/import-products.sh <client-slug> --apply --max-creates 1   # create at most 1 product per request
#
# Needs: BASE (Worker URL) and ADMIN_KEY in the environment, e.g. `set -a; source .env; set +a`.
# Prints one summary line per page and saves each page's full JSON report to ./import-reports/.
# Safe to re-run at any point: SKUs already in Mintsoft are skipped, never overwritten. Stock is never sent.
set -euo pipefail

slug="${1:?usage: $0 <client-slug> [--apply] [--max-creates N]}"
shift
dry_run=true
max_creates=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) dry_run=false ;;
    --max-creates) max_creates="${2:?--max-creates needs a number}"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

: "${BASE:?Set BASE, e.g. export BASE=https://wix-integration.pf-integrations.workers.dev}"
: "${ADMIN_KEY:?Set ADMIN_KEY (the production ADMIN_TOKEN)}"

out_dir="import-reports/$(date +%Y%m%d-%H%M%S)-${slug}"
mkdir -p "$out_dir"
echo "Client: $slug | dry run: $dry_run${max_creates:+ | max creates/request: $max_creates} | reports: $out_dir"

cursor=""
page=0
while :; do
  page=$((page + 1))
  url="$BASE/admin/clients/$slug/import-products?dryRun=$dry_run"
  [[ -n "$cursor" ]] && url+="&cursor=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$cursor")"
  [[ -n "$max_creates" ]] && url+="&maxCreates=$max_creates"

  report="$out_dir/page-$(printf %03d "$page").json"
  status=$(curl -sS -o "$report" -w '%{http_code}' -X POST "$url" -H "Authorization: Bearer $ADMIN_KEY")
  if [[ "$status" != "200" ]]; then
    echo "Page $page: HTTP $status — stopping. Response:" >&2
    cat "$report" >&2; echo >&2
    exit 1
  fi

  # Summary line + next cursor/done flag (python3 ships with macOS).
  read -r summary cursor done stopped < <(python3 - "$report" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
s = (f"dryRun={r['dryRun']} seen={r['variantsSeen']} created={len(r['created'])} "
     f"wouldCreate={len(r['wouldCreate'])} existing={len(r['skippedExisting'])} "
     f"missingSku={len(r['missingSku'])} dupSku={len(r['duplicateSkuInWix'])} "
     f"digital={r['skippedNonPhysical']} errors={len(r['errors'])} "
     f"zeroWeight={sum('zero_weight' in x['flags'] for x in r['created'] + r['wouldCreate'])}")
print(s.replace(" ", "|"), r.get("nextCursor") or "-", str(r["done"]).lower(), r.get("stoppedBy") or "-")
PY
)
  if [[ "$stopped" == "-" ]]; then echo "Page $page: ${summary//|/ }"; else echo "Page $page: ${summary//|/ } stoppedBy=$stopped"; fi
  [[ "$cursor" == "-" ]] && cursor=""

  if [[ "$done" == "true" ]]; then echo "Done."; break; fi
  if [[ "$stopped" == "api_error" ]]; then echo "Stopped on an API error — see $report. Re-run to resume." >&2; exit 1; fi
  if [[ -z "$cursor" && "$stopped" == "-" ]]; then echo "No cursor returned — stopping." >&2; exit 1; fi
  if [[ "$page" -ge 500 ]]; then echo "Stopping after 500 pages as a safety limit." >&2; exit 1; fi
done
