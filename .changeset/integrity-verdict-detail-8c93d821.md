---
'@adhd/sox-store-adapter': patch
'@adhd/sox-extension-memory-server': patch
---

An integrity verdict's detail now agrees with the verdict. A row filtered as the
documented Turso FTS false positive (`wrong # of entries in index
__turso_internal_fts_dir_*_key`, upstream turso#7611) is labelled as filtered
and cites the new `KNOWN_FALSE_POSITIVE_RULE_ID` in the `pragma_integrity_check`
probe detail (surfaced by `memory_ping`), and the new
`formatIntegrityVerdictDetail()` gives callers one verdict-consistent detail
string instead of the raw rows (which printed `integrity_ok=true` next to what
read as a defect). (8c93d821)
