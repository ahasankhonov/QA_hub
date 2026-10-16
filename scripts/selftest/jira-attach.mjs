// Selftest section for the Jira screenshot uploader: scripts/jira-attach-plan.mjs,
// scripts/jira-attach-apply.mjs and lib/jira-attach.mjs. R-01 / R-10.
//
// The uploader talks REST, which the PreToolUse write gate never sees, so its own approval check is
// the only control. Every check below feeds it a known-bad input and asserts the refusal; one
// known-good --dry-run proves the legitimate path still works and makes no network call (fetch and
// net.connect are replaced by throwing stubs via --import).
//
// Everything runs in a sandbox hub under os.tmpdir() with a sandbox HOME: copies of the two scripts
// and their libs, a fake project, fake images and a fake PII scan (its "PII" hash is a fixture
// image's hash, not the real one). The real .qa-approvals/ is never read or written; the SELFTEST
// approval lives in the sandbox and is removed afterwards.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync, readFileSync, symlinkSync, appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalOp } from '../../lib/tracker-ops.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (tag) => Buffer.concat([PNG, Buffer.from(`selftest image ${tag}`)]);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const RUN = 'SELFTEST-ATX';
const SLUG = 'pxselftest';
const CLOUD = '00000000-0000-4000-8000-00000000a77a';

export default function section(h) {
  const { check, assert } = h;
  console.log('\nR-01 Jira REST attachments — plan + self-gating uploader');

  const SB = realpathSync(mkdtempSync(join(tmpdir(), 'qa-selftest-attach-')));
  const HOME = join(SB, '_home');
  try {
    for (const d of ['scripts', 'lib', 'profiles', '.qa-approvals', join(HOME, '.claude')]) mkdirSync(join(SB, d), { recursive: true });
    for (const f of ['scripts/jira-attach-plan.mjs', 'scripts/jira-attach-apply.mjs', 'lib/jira-attach.mjs', 'lib/tracker-ops.mjs', 'lib/cli.mjs', 'lib/profile.mjs', 'lib/jira-ops.mjs'])
      copyFileSync(join(h.HUB, f), join(SB, f));
    writeFileSync(join(SB, 'profiles', `${SLUG}.json`), JSON.stringify({ slug: SLUG, jira: { cloudId: CLOUD, projectKey: 'BET', transitions: { STAGING: '2' }, tools: { transition: 'mcp__claude_ai_Atlassian__transitionJiraIssue', comment: 'mcp__claude_ai_Atlassian__addCommentToJiraIssue' } } }));
    const NOFETCH = join(SB, '_nonet.mjs');
    writeFileSync(NOFETCH, "import net from 'node:net';\nconst no = () => { throw new Error('SELFTEST: network call attempted'); };\nglobalThis.fetch = no; net.connect = no; net.createConnection = no;\n");

    const REP = join(SB, 'projects', SLUG, 'qa-reports');
    const ATT = join(REP, `_JIRA-ATTACHMENTS-${RUN}`);
    const rel = (...p) => ['projects', SLUG, 'qa-reports', ...p].join('/');
    const put = (p, buf) => (mkdirSync(join(p, '..'), { recursive: true }), writeFileSync(p, buf), buf);
    const A = put(join(ATT, 'RC-01', '1-a.png'), png('a'));
    put(join(ATT, 'RC-01', '2-b.png'), png('b'));
    const PII = put(join(ATT, 'RC-02', '1-pii.png'), png('pii-fixture'));
    put(join(ATT, 'RC-02', '2-text.png'), Buffer.from('this is not an image\n'));
    put(join(REP, 'outside.png'), png('outside'));
    symlinkSync(join(REP, 'outside.png'), join(ATT, 'RC-01', '3-link.png'));
    // Fake PII scan: the injected hash is a FIXTURE image's, plus one flagged-by-name file.
    put(join(REP, `_E2E-${RUN}_attachments`, 'PAR-1', 'flagged.png'), png('flagged-source'));
    writeFileSync(join(REP, `_PII-SCAN-${RUN}-android.json`), JSON.stringify({ run: RUN, findings: [
      { file: 'PAR-1/flagged.png', severity: 'high', actionTaken: `not masked (sha256 ${sha(PII)})` },
      { file: 'PAR-1/clean.png', severity: 'none' },
    ] }));
    put(join(ATT, 'RC-03', '1-flagged-copy.png'), png('flagged-source'));

    // Applied records: the APPLIED json (keys) + the gate's NB jsonl + the CM jsonl.
    const nbOps = [{ opId: 'op-001', draftId: 'B01', key: 'BET-501', summary: '[iOS] BET – P3 – Talaba – X – first bug title here' },
      { opId: 'op-002', draftId: 'B03', key: 'BET-502', summary: '[iOS] BET – P4 – Talaba – X – third bug title here' }];
    const APPLIED = join(REP, `_JIRA-NEWBUGS-APPLIED-${RUN}.json`);
    writeFileSync(APPLIED, JSON.stringify({ runId: `${RUN}-NB`, planned: 2, applied: 2, mapping: { B01: 'BET-501', B03: 'BET-502' }, ops: nbOps }));
    writeFileSync(join(SB, '.qa-approvals', `${RUN}-NB.applied.jsonl`), nbOps.map((o) => JSON.stringify({ runId: `${RUN}-NB`, opId: o.opId, summary: `create Bug in BET [Low]: ${o.summary}` })).join('\n') + '\n');
    const CM = join(SB, '.qa-approvals', `${RUN}-CM.applied.jsonl`);
    writeFileSync(CM, JSON.stringify({ runId: `${RUN}-CM`, opId: 'op-001', summary: 'comment on BET-22 (300 chars): ...' }) + '\n');

    const folder = (rc) => `_JIRA-ATTACHMENTS-${RUN}/${rc}`;
    const goodMap = [
      { opId: 'op-001', op: 'create', draftId: 'B01', target: nbOps[0].summary, folder: folder('RC-01'), files: ['1-a.png'] },
      { opId: 'op-002', op: 'create', draftId: 'B02', target: 'never filed', folder: null, files: [] },
      { opId: 'op-003', op: 'create', draftId: 'B03', target: nbOps[1].summary.replace('P4', 'P3'), folder: folder('RC-01'), files: ['2-b.png'] },
      { opId: 'C01', op: 'comment', target: 'BET-22', folder: folder('RC-01'), files: ['1-a.png'] },
    ];
    const mapFile = (name, entries) => (writeFileSync(join(SB, name), JSON.stringify(entries)), join(SB, name));
    const env = { ...process.env, HOME };
    delete env.TELEGRAM_STATE_DIR;
    const planRun = (map, extra = [], out = join(SB, 'plan.json')) =>
      spawnSync('node', [join(SB, 'scripts', 'jira-attach-plan.mjs'), '--map', map, '--applied', APPLIED, '--applied-cm', CM, '--project', SLUG, '--run', RUN, '--out', out, ...extra], { encoding: 'utf8', cwd: SB, env });
    const applyRun = (plan) =>
      spawnSync('node', ['--import', pathToFileURL(NOFETCH).href, join(SB, 'scripts', 'jira-attach-apply.mjs'), '--plan', plan, '--dry-run'], { encoding: 'utf8', cwd: SB, env });
    const out = (r) => (r.stdout || '') + (r.stderr || '');
    const APPROVAL = join(SB, '.qa-approvals', `${RUN}-AT.approved.json`);
    const approve = (planPath, over = {}) => {
      const raw = readFileSync(planPath, 'utf8');
      const plan = JSON.parse(raw);
      writeFileSync(APPROVAL, JSON.stringify({ schemaVersion: 1, runId: plan.runId, project: plan.project, approvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), userQuote: 'SELFTEST', planPath: planPath.slice(SB.length + 1), planSha256: sha(raw),
        ops: plan.ops.map((o) => ({ opId: o.opId, tool: o.tool, hash: o.hash, maxApplies: 1 })), ...over }));
    };
    const GOOD = join(SB, 'plan.json');

    // ---------------------------------------------------------------- the plan generator
    check('attach-plan: a good map plans one op per (key, file); an uncreated draft with no files is SKIPPED with a reason; resolves by draftId despite a P-level change', () => {
      const r = planRun(mapFile('map-good.json', goodMap));
      h.mustAccept(r, 'jira-attach-plan on a good map');
      const p = JSON.parse(readFileSync(GOOD, 'utf8'));
      assert(p.runId === `${RUN}-AT` && p.cloudId === CLOUD, `runId/cloudId wrong: ${p.runId} ${p.cloudId}`);
      assert(p.ops.length === 3, `expected 3 ops, got ${p.ops.length}`);
      assert(p.ops.map((o) => o.issueKey).join() === 'BET-501,BET-502,BET-22', `keys wrong: ${p.ops.map((o) => o.issueKey)}`);
      assert(p.ops.every((o) => o.tool === 'jira-rest-attach' && /^att-BET-\d+-[0-9a-f]{12}$/.test(o.opId) && o.contentType === 'image/png'), 'op shape wrong');
      assert(p.skipped.some((s) => s.draftId === 'B02' && /never created/.test(s.reason)), `uncreated draft not recorded: ${JSON.stringify(p.skipped)}`);
      const again = planRun(mapFile('map-good.json', goodMap), [], join(SB, 'plan-2.json'));
      h.mustAccept(again, 'second plan run');
      assert(JSON.parse(readFileSync(join(SB, 'plan-2.json'), 'utf8')).ops.map((o) => o.opId).join() === p.ops.map((o) => o.opId).join(), 'opIds are not deterministic');
    });
    check('attach-plan REFUSES an uncreated draft that has files', () => {
      h.mustReject(planRun(mapFile('m1.json', [{ ...goodMap[1], folder: folder('RC-01'), files: ['1-a.png'] }]), [], join(SB, 'x.json')), 'was never created', 'uncreated draft with files');
    });
    check('attach-plan REFUSES a comment key that is not in the applied CM record', () => {
      h.mustReject(planRun(mapFile('m2.json', [{ ...goodMap[3], target: 'BET-999' }]), [], join(SB, 'x.json')), 'not in the applied mappings', 'unknown comment key');
    });
    check('attach-plan REFUSES the PII-scan hash, a flagged file\'s renamed copy, a non-image, a symlink and a ".." path', () => {
      const r = planRun(mapFile('m3.json', [
        { ...goodMap[0], folder: folder('RC-02'), files: ['1-pii.png', '2-text.png'] },
        { ...goodMap[2], folder: folder('RC-03'), files: ['1-flagged-copy.png'] },
        { ...goodMap[3], files: ['3-link.png', '../../outside.png'] },
      ]), [], join(SB, 'x.json'));
      h.mustReject(r, 'PII-flagged', 'PII fixture hash');
      for (const needle of ['magic bytes', 'is a symlink', '".."']) assert(out(r).includes(needle), `no "${needle}" refusal:\n${out(r).slice(0, 800)}`);
      assert((out(r).match(/PII-flagged/g) || []).length >= 2, `the flagged file's renamed copy was not caught:\n${out(r).slice(0, 800)}`);
      assert(!existsSync(join(SB, 'x.json')), 'a refused plan was still written');
    });
    check('attach-plan REFUSES a duplicate (key, sha256)', () => {
      h.mustReject(planRun(mapFile('m4.json', [{ ...goodMap[0], files: ['1-a.png'] }, { ...goodMap[0], files: ['1-a.png'] }]), [], join(SB, 'x.json')), 'duplicates an image', 'duplicate key+sha');
    });
    check('attach-plan --drop leaves a refused file out and records why; a --drop that matches nothing is refused', () => {
      const textRel = rel(`_JIRA-ATTACHMENTS-${RUN}`, 'RC-01', '9-text.png');
      writeFileSync(join(ATT, 'RC-01', '9-text.png'), 'not an image\n');
      try {
        const m = mapFile('m5.json', [{ ...goodMap[0], files: ['1-a.png', '9-text.png'] }]);
        h.mustReject(planRun(m, [], join(SB, 'x.json')), 'magic bytes', 'non-image without --drop');
        h.mustReject(planRun(m, ['--drop', `${textRel},${rel('nope.png')}`], join(SB, 'x.json')), 'matches no file', 'unused --drop');
        const r = planRun(m, ['--drop', textRel], join(SB, 'p5.json'));
        h.mustAccept(r, '--drop of a refused file');
        const p = JSON.parse(readFileSync(join(SB, 'p5.json'), 'utf8'));
        assert(p.ops.length === 1 && p.excluded.length === 1 && /magic bytes/.test(p.excluded[0].reasons.join()), `excluded not recorded: ${JSON.stringify(p.excluded)}`);
      } finally {
        rmSync(join(ATT, 'RC-01', '9-text.png'), { force: true });
      }
    });

    // ---------------------------------------------------------------- the uploader (--dry-run only)
    check('attach-apply REFUSES with no approval on file (dry-run reports it, does not skip it)', () => {
      rmSync(APPROVAL, { force: true });
      const r = applyRun(GOOD);
      h.mustReject(r, 'no approval', 'missing approval');
      assert(!/would send/.test(out(r)), 'printed would-send ops without an approval');
    });
    check('attach-apply REFUSES an approval whose sha256 is not the plan\'s bytes', () => {
      approve(GOOD, { planSha256: sha('some other plan') });
      h.mustReject(applyRun(GOOD), 'sha256 mismatch', 'approval sha mismatch');
    });
    check('attach-apply REFUSES a plan edited after approval (one byte)', () => {
      approve(GOOD);
      const raw = readFileSync(GOOD, 'utf8');
      writeFileSync(GOOD, raw + ' ');
      try {
        h.mustReject(applyRun(GOOD), 'changed after approval', 'plan edited after approval');
      } finally {
        writeFileSync(GOOD, raw);
      }
    });
    check('attach-apply REFUSES an expired approval', () => {
      approve(GOOD, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
      h.mustReject(applyRun(GOOD), 'expired', 'expired approval');
    });
    /** A plan with exactly these ops, in the plan script's shape, hashed by the gate's own canonicalisation. */
    const opPlan = (name, mutate) => {
      const p = JSON.parse(readFileSync(GOOD, 'utf8'));
      p.ops = mutate(p.ops[0]);
      for (const o of p.ops) {
        o.args = { issueKey: o.issueKey, path: o.path, filename: o.path.split('/').pop(), sha256: o.sha256, bytes: o.bytes, contentType: o.contentType };
        o.hash = canonicalOp(o.tool, o.args).hash;
      }
      const f = join(SB, name);
      writeFileSync(f, JSON.stringify(p, null, 2) + '\n');
      return f;
    };
    const piiPlan = () => opPlan('plan-pii.json', (o) => [{ ...o, opId: 'att-pii', path: rel(`_JIRA-ATTACHMENTS-${RUN}`, 'RC-02', '1-pii.png'), sha256: sha(PII), bytes: PII.length }]);
    const outsidePlan = () => opPlan('plan-outside.json', (o) => [{ ...o, opId: 'att-out', path: rel('outside.png'), sha256: sha(png('outside')), bytes: png('outside').length }]);
      check('attach-apply REFUSES the PII hash (fixture hash injected via a fake PII scan) even in an approved plan', () => {
        const f = piiPlan();
        approve(f);
        h.mustReject(applyRun(f), 'PII-flagged', 'approved PII op');
      });
      check('attach-apply REFUSES a path outside the attachments folder even in an approved plan', () => {
        const f = outsidePlan();
        approve(f);
        h.mustReject(applyRun(f), 'resolves outside', 'approved op outside the folder');
      });
      check('attach-apply REFUSES a file changed after approval', () => {
        approve(GOOD);
        writeFileSync(join(ATT, 'RC-01', '1-a.png'), png('a-swapped'));
        try {
          h.mustReject(applyRun(GOOD), 'changed since the plan', 'file swapped after approval');
        } finally {
          writeFileSync(join(ATT, 'RC-01', '1-a.png'), A);
        }
      });
      check('attach-apply known-good --dry-run with a SELFTEST approval: exit 0, lists would-send ops, no network; skips an op already uploaded; approval removed after', () => {
        approve(GOOD);
        const r = applyRun(GOOD);
        h.mustAccept(r, 'approved good plan --dry-run');
        assert((out(r).match(/would send /g) || []).length === 3 && /no network call made/.test(out(r)), `dry-run output wrong:\n${out(r).slice(0, 800)}`);
        assert(!/network call attempted/.test(out(r)), 'the dry-run reached the network stub');
        const p = JSON.parse(readFileSync(GOOD, 'utf8'));
        const applied = join(SB, '.qa-approvals', `${RUN}-AT.applied.jsonl`);
        appendFileSync(applied, JSON.stringify({ runId: p.runId, opId: p.ops[0].opId, hash: p.ops[0].hash, status: 'uploaded', attachmentId: '1' }) + '\n');
        const r2 = applyRun(GOOD);
        h.mustAccept(r2, 're-run after one upload');
        assert(/2 to send, 1 already uploaded/.test(out(r2)), `re-run is not idempotent:\n${out(r2).slice(0, 500)}`);
        rmSync(applied, { force: true });
        rmSync(APPROVAL, { force: true });
        assert(!existsSync(APPROVAL), 'SELFTEST approval was not removed');
        h.mustReject(applyRun(GOOD), 'no approval', 'after revoking the SELFTEST approval');
      });

    // ---------------------------------------------------------------- iOS-style scan: { images: [{ path, sha256, flagged }] }
    const IOS_SCAN = join(REP, `_PII-SCAN-${RUN}-ios.json`);
    const IOS_NAME = `_PII-SCAN-${RUN}-ios.json`;
    check('attach-plan refuses BY HASH an image a _PII-SCAN-<run>-ios.json flags (no --drop): left out, recorded as "PII-flagged (<scan>)"; a sha-less flagged path is hashed (renamed copy caught); flagged:false is planned; apply refuses it even approved', () => {
      const IOSPII = put(join(ATT, 'RC-04', '1-ios-flag.png'), png('ios-pii'));
      const NOSHA = put(join(ATT, 'RC-04', '2-ios-nosha.png'), png('ios-pii-nosha'));
      put(join(ATT, 'RC-05', '1-renamed.png'), NOSHA);
      writeFileSync(IOS_SCAN, JSON.stringify({ run: RUN, platform: 'ios', images: [
        { opId: 'x', issueKey: 'BET-501', path: rel(`_JIRA-ATTACHMENTS-${RUN}`, 'RC-04', '1-ios-flag.png'), sha256: sha(IOSPII), flagged: true, reason: 'phone' },
        { issueKey: 'BET-501', path: rel(`_JIRA-ATTACHMENTS-${RUN}`, 'RC-04', '2-ios-nosha.png'), flagged: true, reason: 'code' },
        { issueKey: 'BET-501', path: rel(`_JIRA-ATTACHMENTS-${RUN}`, 'RC-01', '1-a.png'), sha256: sha(A), flagged: false },
      ] }));
      try {
        const m = mapFile('m-ios.json', [
          { ...goodMap[0], folder: folder('RC-04'), files: ['1-ios-flag.png', '2-ios-nosha.png'] },
          { ...goodMap[2], folder: folder('RC-05'), files: ['1-renamed.png'] },
          goodMap[3],
        ]);
        const r = planRun(m, [], join(SB, 'p-ios.json'));
        h.mustAccept(r, 'plan with iOS-flagged images');
        const p = JSON.parse(readFileSync(join(SB, 'p-ios.json'), 'utf8'));
        assert(p.ops.length === 1 && p.ops[0].issueKey === 'BET-22' && p.ops[0].sha256 === sha(A), `flagged:false image not planned alone: ${JSON.stringify(p.ops.map((o) => o.path))}`);
        const want = `PII-flagged (${IOS_NAME})`;
        assert(p.excluded.length === 3 && p.excluded.every((x) => x.reason === want), `refusals not recorded as "${want}": ${JSON.stringify(p.excluded)}`);
        assert(p.excluded.some((x) => x.opId === `att-BET-501-${sha(IOSPII).slice(0, 12)}`), 'refused op has no opId');
        assert(p.excluded.some((x) => x.sha256 === sha(NOSHA) && x.issueKey === 'BET-502'), `the renamed copy of the sha-less flagged path was not refused: ${JSON.stringify(p.excluded)}`);
        assert(p.piiScans.some((s) => s.file.endsWith(IOS_NAME)), 'the iOS scan is not recorded in plan.piiScans');
        const f = opPlan('plan-ios-pii.json', (o) => [{ ...o, opId: 'att-ios-pii', path: rel(`_JIRA-ATTACHMENTS-${RUN}`, 'RC-04', '1-ios-flag.png'), sha256: sha(IOSPII), bytes: IOSPII.length }]);
        approve(f);
        h.mustReject(applyRun(f), want, 'approved op on an iOS-flagged image');
      } finally {
        rmSync(IOS_SCAN, { force: true });
        rmSync(APPROVAL, { force: true });
      }
    });
    check('a malformed _PII-SCAN-<run>-*.json fails closed: plan refused and not written, apply refused (not skipped)', () => {
      writeFileSync(IOS_SCAN, '{ "images": [ { "sha256": "abc", ');
      try {
        h.mustReject(planRun(mapFile('m-bad-scan.json', goodMap), [], join(SB, 'x-bad.json')), 'unparseable', 'plan with a malformed scan');
        assert(!existsSync(join(SB, 'x-bad.json')), 'a plan was written despite a malformed scan');
        approve(GOOD);
        h.mustReject(applyRun(GOOD), 'unparseable', 'apply with a malformed scan');
        writeFileSync(IOS_SCAN, JSON.stringify({ run: RUN, summary: 'no entry arrays' }));
        h.mustReject(planRun(mapFile('m-bad-scan.json', goodMap), [], join(SB, 'x-bad.json')), 'neither an "images" nor a "findings"', 'plan with a scan that lists nothing');
      } finally {
        rmSync(IOS_SCAN, { force: true });
        rmSync(APPROVAL, { force: true });
      }
    });
  } finally {
    rmSync(SB, { recursive: true, force: true }); // the SELFTEST approval goes with it
  }
}
