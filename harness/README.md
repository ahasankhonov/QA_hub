# harness/ — the test harness, as code (R-14)

Before this existed, each ticket got its own throwaway script: `car18_01_recon.js`,
`car18_02_click_badge.js`, … 300+ of them under `projects/alpha/`. Every one re-derived the same
login, the same chip-clicking workaround, the same form order. When the login flow changed, nothing
was fixed — the next script just rediscovered it.

A harness module is the opposite: the knowledge lives in one place, and a ticket script is a short
file that composes it.

```
harness/
  lib/
    pw.mjs         resolve playwright (hub devDependency, pinned; `npm install` in the hub once)
    evidence.mjs   typed evidence + RunResult (write-through, R-08/R-09) + classifyFailure()
    page.mjs       waitForPageReady() (visible loaders gone) + pageOutline() (visible text tree)
  alpha/
    config.mjs     hosts, accounts, PAYGW/UAT, and assertStaging() — the prod tripwire (R-13)
    auth.mjs       login per role, session reuse, two-actor contexts
    ui.mjs         the DOM quirks: visible-chip clicking, condition radios, ordered fills
    listing.mjs    create sell listing → offer → counter → accept
    api.mjs        direct API calls returning typed evidence
```

## Writing a ticket script

One file per ticket, under `harness/<project>/tickets/`. It sets up with the module, asserts what
the ticket is about, and writes its result file as it goes.

```js
// harness/alpha/tickets/ALP-537.mjs
import { launch, contextFor } from '../auth.mjs';
import { createSellListing } from '../listing.mjs';
import { capture, RunResult } from '../../lib/evidence.mjs';
import { reportsDir } from '../../../lib/profile.mjs';
import { SURFACES } from '../config.mjs';

const buildId = process.env.QA_BUILD_ID;          // from scripts/build-id.mjs — never guessed
const rec = new RunResult({ ticketId: 'ALP-537', project: 'alpha', runId: process.env.QA_RUN,
                            buildId, reportsDir: reportsDir('alpha') });

const browser = await launch();
const customer = await contextFor(browser, 'customer');
const listing = await createSellListing(customer);   // setup: one call, no assertions

await rec.case('AC-1', { surface: SURFACES.customer, expected: 'listing publishes as Available' },
  () => capture(listing.page, { selector: '[data-status]', ready: true, outline: true }));

await browser.close();
console.log(rec.write());
```

Then, before anything is adjudicated:

```
node scripts/run-result-validate.mjs --result projects/alpha/qa-reports/_RESULT-<run>-ALP-537.json --build $QA_BUILD_ID
```

### Capture options (harness/lib/page.mjs, added 2026-10-16)

- `ready: true` (or `{ timeout }`) waits for `waitForPageReady()` first: DOM loaded, network idle
  (bounded — websocket SPAs never go idle), no **visible** loader from `LOADING_SELECTORS`, finite
  animations done. It never throws; it records `evidence.pageReady = { ms, pending }`. A capture with a
  loader still in `pending` is flagged by the validator as a timing suspect — re-capture, don't fail it.
- `outline: true` records `evidence.outline`, a ≤3000-char text tree of what is visible (roles, labels,
  values, states; password values hidden). The verifier reads it instead of opening a screenshot. It
  is recorded automatically whenever the `selector` did not resolve, so a miss says what WAS on screen.
- When a case throws, `rec.case()` records `failureClass` (`classifyFailure()`): `guard_refused`,
  `assertion_failure`, `element_not_found`, `timeout`, `browser_disconnect`, `infrastructure`,
  `harness_bug`, `unknown_failure`. Anything but `assertion_failure` is a harness/browser/network failure
  — the validator warns "rerun before adjudicating"; `guard_refused` means report the link (R-13).

A project with its own wait (Alpha `ui.mjs` `settle()`) keeps it for its own steps; `ready` is for the
moment evidence is taken.

### One element, the right element (harness/lib/page.mjs, added 2026-10-16)

- `capture({ selector })` records `matchCount`, the number of visible matches. Above 1,
  `run-result-validate` warns, because `observedText` came from whichever element was first.
- `clickUnique(page, sel)` clicks only when exactly one visible element matches. It throws on 0 or
  2+. Narrow the locator to a region plus `filter({ hasText })`; never use `.first()`, `nth()` or
  `force: true` to get past it.
- `fillAndConfirm(page, [[sel, value], …])` fills in order, then reads every field back. It throws
  naming any field a later fill cleared.
- `assertLinkHost(page, sel, { allow, forbid })` returns `{ href, host, ok, why }` without clicking.
  Use it for any link that may lead to production.
- `new RunResult(…)` throws without `runId` and `ticketId`, and refuses an existing result file
  unless you pass `resume: true` or `overwrite: true`, or set `QA_OVERWRITE_RESULT=1`.
- `rec.created(caseId, { type, id, label, cleanup })` registers test data a case made (listing, offer,
  account, upload) in the result's `created[]`, written through at once. `cleanup` is `'deleted'`,
  `'left'` (the label says why) or `'needs-admin'`; the same `type`+`id` again updates the entry
  (`'left'` → `'deleted'` after teardown). `node scripts/residue.mjs --project <slug> [--write]` folds
  every run into the open list, `_RESIDUE.md` (generated, added 2026-10-16).
- Alpha `payDepositWithTrxCard` refuses to type a card into any frame not served by
  `*.uat.payments.example` (the UAT host).

## Rules that bind harness code

- **R-05** `rec.case()` throws without a `surface`. The validator compares it against the host the
  evidence was actually taken on — testing the wrong surface caused ~45 of ~84 false fails in the
  2026-07-23 audit, and it is a string comparison, not a judgement call.
- **R-08** `rec.case()` writes the file after every case. Two parts of the 2026-08-12 run were
  cancelled mid-flight; the ones that batched their write-up lost everything.
- **R-09** evidence is `url` / `httpStatus` / `selector` / `observedText` / `buildId`, captured from
  the page. Prose is commentary.
- **R-13** every navigation goes through `assertStaging()`. `alpha.example` shares its domain, S3
  bucket, PAYGW gateway, DocuSign account and mail with staging, so a wrong host is a production
  write, not a wasted test.

## Adding a project

Copy the shape, not the contents: `config.mjs` (hosts + accounts + the project's safety guard),
`auth.mjs`, and whatever the domain's expensive setup is. Anything that took more than one attempt
to get right belongs in the module with a comment saying what went wrong — that comment is the
reason the next run does not repeat it.

## Alpha admin form templates / packet routing (learned R21 ALP-742, 2026-10-15)

- Admin Deal documents upload: attaching the file creates the record immediately (POST /forms 201); "Save" only sets metadata
  (Type/State/title). The Type control is a custom ul/li list; Escape does not close it (it intercepts the Save click).
- Parse (AI) selects a platform mapping key (RI -> `ri_registration_v1`) and reports mapped/unmapped/ready; Publish has no confirm dialog.
  Template resolution is "newest published wins" per state + docType.
- The stored original is downloadable from the form record's presigned `fileUrl` (byte-identical to the upload); `GET /forms/{id}/preview`
  is a different, flattened sample-filled copy. Compare with `harness/alpha/tickets/R21-ALP-742-tpl-check.mjs`, `pdf_widget_table.py`
  (widget labels) and `pdf_fill_compare.py` (rendered value per widget).
- `POST /deal/{id}/generate-packet` returns 404 "No form templates configured for state 'XX'" for states without BoS/odometer/P&S templates,
  even if a state-registration form is published. The packet editor preview is `POST /deal/{id}/documents/{templateId}/preview`.
- Packet routing keys off `deal.dealer.state`; Deal Control REGISTRATION radios are No registration / Register in dealership state /
  Register in another state. On a configured deal "Fill deal form" opens the packet editor; reach Deal Control through the "Edit deal pricing" link.
  "Regenerate packet" generates immediately. On a fresh test-drive deal "Fill deal form" opens the packet editor directly.
- Admin user search is name-only and the R18 contact name is shared: approve the dealer by its unique timestamp row.
  R18-dealer-onboarding.mjs accepts env overrides (QA_DEALER_PREFIX / D_ADDR / D_CITY / D_ZIP / D_STATE) for a disposable out-of-state dealer.
- Test-drive path on the STORE host: tickets/R21-ALP-742-td.mjs (stages CUST1, CUST2, DEAL, WIZ, PACKET) is the compact copy of ALP-740 TD1-TD7.
