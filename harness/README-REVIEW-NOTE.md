# Note for reviewers

`harness/beta/` contains only `config.mjs`, the surface guard (R-13) that `npm run selftest` exercises.
The rest of a project harness (login, data setup, UI helpers per platform) is application-specific and is not part of
this review copy. `harness/lib/` holds the shared, project-agnostic building blocks.
