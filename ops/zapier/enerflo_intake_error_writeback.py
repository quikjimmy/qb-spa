# =============================================================================
# Enerflo intake — error-branch write-back  (Zapier "Code by Zapier" → Python)
# =============================================================================
# Drop this on the ERROR branch of any create step in the Enerflo→Projects Zap
# (Create Contact / Create Project / Create Project Company). It stamps the
# Enerflo Data row (QB table bscp8usde) so the monitor knows the deal failed and
# WHERE it broke.
#
# Reuse it on every error branch — change only the `step` input per branch.
#
# ---- Map these under the step's "Input Data" (name = value) -----------------
#   deal_rid   -> Enerflo Data row Record ID# (field 3)
#   step       -> this branch's step name, e.g. "Create Contact"
#   error_msg  -> the failed step's error detail if the branch exposes it (else blank)
#   realm      -> kin.quickbase.com
#   token      -> a QuickBase USER TOKEN with WRITE access to bscp8usde
#   table      -> bscp8usde
#
# ---- Notes ------------------------------------------------------------------
#   * Zapier's Python step exposes inputs via `input_data` (all strings) and
#     requires you to set `output`. `requests` is NOT available, so we use the
#     standard-library `urllib`.
#   * Do NOT write field 148 (Signed not Submitted) — it's a FORMULA field;
#     QuickBase maintains it and will reject a write.
#   * Raising on a bad write-back makes the failure show up in the Zap run
#     history instead of being lost silently.
# =============================================================================

import json
import urllib.request
import urllib.error
from datetime import datetime, timezone

# Zapier injects `input_data` (dict of the mapped inputs) and `output` at runtime
# as module globals. Reading it via globals() avoids referencing an "undefined"
# name (keeps editors/linters quiet) and lets the file run locally unchanged —
# inside Zapier the injected value is found; elsewhere it falls back to {}.
input_data = globals().get('input_data', {})

deal_rid  = (input_data.get('deal_rid')  or '').strip()
step      = (input_data.get('step')      or 'unknown step').strip()
error_msg = (input_data.get('error_msg') or 'failed').strip()
realm     = (input_data.get('realm')     or 'kin.quickbase.com').strip()
token     = (input_data.get('token')     or '').strip()
table     = (input_data.get('table')     or 'bscp8usde').strip()

if not deal_rid or not token:
    raise ValueError('deal_rid and token are required')

msg = ' '.join(error_msg.split())[:200]
now_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

# ---- Fields to write --------------------------------------------------------
# DEFAULT (zero new fields): pack the step + short message into 157 Record Status
# so it's readable today. If you add dedicated "Intake Step" / "Intake Error"
# fields, change 157 to just 'Error' and uncomment the two lines below.
fields = {
    '3':   {'value': int(deal_rid)},                       # Record ID# (merge key)
    '157': {'value': ('Error @ %s: %s' % (step, msg))[:250]},  # Record Status
    '156': {'value': now_iso},                             # Last Submission Date
    # '<INTAKE_STEP_FID>':  {'value': step},               # which step failed
    # '<INTAKE_ERROR_FID>': {'value': msg},                # the error text
}

payload = {
    'to': table,
    'mergeFieldId': 3,          # merge on Record ID# → updates the existing row
    'data': [fields],
}

req = urllib.request.Request(
    'https://api.quickbase.com/v1/records',
    data=json.dumps(payload).encode('utf-8'),
    method='POST',
    headers={
        'QB-Realm-Hostname': realm,
        'Authorization': 'QB-USER-TOKEN ' + token,
        'Content-Type': 'application/json',
    },
)

try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    detail = e.read().decode('utf-8', 'replace')[:300]
    raise Exception('QB write-back HTTP %s: %s' % (e.code, detail))

line_errors = (body.get('metadata') or {}).get('lineErrors')
if line_errors:
    raise Exception('QB write-back rejected: ' + json.dumps(line_errors))

output = {'ok': True, 'step': step, 'status': 'Error', 'error_msg': msg}
