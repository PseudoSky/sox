# E execute (gated)

Status: gated. This version has no live broker, no credentials, and no order calls. The `live:<account_id>` plan mode is validated and stored, and that is all.

Contract for a future broker-live binding: an approval record `{account_id, approved: true, approved_by, approved_at}` must name the account the order targets; the binding implements connect, positions, cash, preview, place, cancel, reconcile. Paper implements the same shape locally.
