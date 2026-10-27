# M100–M103 report

Backend 1589 pass / 38 skipped (Docker); frontend 1080 pass; builds clean.

## Residual risks (oracle review of M100)
- Move/delete still has a TOCTOU window; closing it needs dirfd pinning or sandbox-uid isolation. `mkdir(recursive)` runs before pinning.
- Import quota reservation is per process and not atomic against plain project creates.

## Not browser-verified
- Secondary editor groups with document-level listeners (`ide-save`, `ide-reveal-location`); viewer/preview/terminal tabs UI.
