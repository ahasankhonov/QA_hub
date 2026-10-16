// Selftest section for the pieces taken from denfry/claude-skills on 2026-10-16 (see _IDEAS-FROM-REPOS.md):
// the per-agent `tools:` allowlists in .claude/agents/*.md, guarded by scripts/agent-tools-check.mjs.
// (The other take, session-cost --baseline, is tested in the session-cost section.)
//
// A tool missing from an allowlist fails silently: the agent just never sees it. So every bad input
// here is one real agent file with one mutation, and the live files must pass untouched.

import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseAgent, namedTools, checkAgent, checkDir } from '../agent-tools-check.mjs';

export default function section(h) {
  const { check, assert, TMP, HUB } = h;
  const DIR = join(TMP, 'denfry-ideas');
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const AGENTS = join(HUB, '.claude', 'agents');
  const live = (name) => readFileSync(join(AGENTS, `${name}.md`), 'utf8');
  const codes = (name, text) => checkAgent(`${name}.md`, text).map((f) => f.code);
  const toolsLine = (text) => text.match(/^tools:.*$/m)[0];
  const drop = (text, tool) => text.replace(toolsLine(text), toolsLine(text).replace(new RegExp(`,\\s*${tool}(?=,|$)`), ''));
  const addTool = (text, tool) => text.replace(toolsLine(text), `${toolsLine(text)}, ${tool}`);
  const cli = (dir) => spawnSync('node', [join(HUB, 'scripts', 'agent-tools-check.mjs'), '--dir', dir], { encoding: 'utf8' });

  console.log('\nRepo ideas (denfry): agent tool allowlists');

  check('agent-tools: the live agent files pass, and the restricted five carry an allowlist', () => {
    const r = checkDir(AGENTS);
    const bad = r.agents.flatMap((a) => a.findings.map((f) => `${f.agent} ${f.code}: ${f.msg}`));
    assert(r.ok, `live agents fail: ${[...bad, ...r.missing.map((m) => `missing ${m}`)].join(' | ')}`);
    for (const a of ['report-writer', 'requirements-analyst', 'test-executor', 'verifier', 'ticket-intake'])
      assert(parseAgent(live(a)).tools?.length > 0, `${a} has no tools: line`);
    for (const a of ['qa-orchestrator', 'linear-writer']) assert(parseAgent(live(a)).tools === null, `${a} must stay on all tools`);
  });

  check('agent-tools: the name scan finds the six tools ticket-intake names (the check is not vacuous)', () => {
    const named = namedTools(parseAgent(live('ticket-intake')).body).sort();
    const want = ['asana_get_attachments_for_object', 'asana_get_stories_for_task', 'asana_get_task', 'get_issue', 'list_comments', 'list_issues'];
    assert(JSON.stringify(named) === JSON.stringify(want), `named: ${named.join(', ')}`);
  });

  check('agent-tools: a tool the prompt names but the list dropped → named-not-listed', () => {
    const c = codes('ticket-intake', drop(live('ticket-intake'), 'mcp__claude_ai_Linear__list_comments'));
    assert(c.includes('named-not-listed'), `got ${c.join(', ') || 'nothing'}`);
  });

  check('agent-tools: executor without Gmail (R-02 email coverage) → required-missing', () => {
    const c = codes('test-executor', drop(live('test-executor'), 'mcp__claude_ai_Gmail__get_thread'));
    assert(c.includes('required-missing'), `got ${c.join(', ') || 'nothing'}`);
  });

  check('agent-tools: Linear save_comment, Jira addCommentToJiraIssue and Gmail send_message → write-tool (R-01)', () => {
    for (const t of ['mcp__claude_ai_Linear__save_comment', 'mcp__claude_ai_Atlassian__addCommentToJiraIssue', 'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Asana__asana_update_task']) {
      const c = codes('verifier', addTool(live('verifier'), t));
      assert(c.includes('write-tool'), `${t}: got ${c.join(', ') || 'nothing'}`);
    }
  });

  check('agent-tools: a typo in an MCP name and in a built-in → unknown-tool', () => {
    for (const t of ['mcp__claude_ai_Linear__get_issues', 'mcp__claude_ai_Lineer__get_issue', 'Bassh']) {
      const c = codes('verifier', addTool(live('verifier'), t));
      assert(c.includes('unknown-tool') && !c.includes('write-tool'), `${t}: got ${c.join(', ') || 'nothing'}`);
    }
  });

  check('agent-tools: MCP tools without ToolSearch → mcp-needs-toolsearch; MCP-free report-writer needs none', () => {
    const c = codes('verifier', drop(live('verifier'), 'ToolSearch'));
    assert(c.includes('mcp-needs-toolsearch'), `got ${c.join(', ') || 'nothing'}`);
    assert(!codes('report-writer', live('report-writer')).length, 'report-writer (no MCP, no ToolSearch) should pass');
  });

  check('agent-tools: restricted agent loses its line → no-allowlist; linear-writer gains one → must-stay-open', () => {
    const rw = live('report-writer').replace(/^tools:.*\n/m, '');
    assert(codes('report-writer', rw).includes('no-allowlist'), 'report-writer without tools: passed');
    const lw = live('linear-writer').replace(/^model:.*$/m, (m) => `${m}\ntools: Bash, Read`);
    assert(codes('linear-writer', lw).includes('must-stay-open'), 'linear-writer with tools: passed');
    assert(!codes('project-onboarder', live('project-onboarder')).length, 'project-onboarder (open by choice) should pass');
  });

  check('agent-tools: a duplicate entry → duplicate; the YAML-list form parses like the inline one', () => {
    assert(codes('report-writer', addTool(live('report-writer'), 'Bash')).includes('duplicate'), 'duplicate Bash passed');
    const text = live('report-writer');
    const yaml = text.replace(toolsLine(text), 'tools:\n  - Bash\n  - Read\n  - Edit\n  - Write\n  - Skill');
    assert(JSON.stringify(parseAgent(yaml).tools) === JSON.stringify(parseAgent(text).tools), `yaml parsed as ${JSON.stringify(parseAgent(yaml).tools)}`);
    assert(!codes('report-writer', yaml).length, 'yaml-list report-writer should pass');
  });

  check('agent-tools: a generic backticked word (`search`, `fetch`) is not a tool mention', () => {
    const text = live('report-writer') + '\nUse `search` and `fetch` in the doc text; `grep` the archive.\n';
    assert(!namedTools(parseAgent(text).body).length, `named: ${namedTools(parseAgent(text).body).join(', ')}`);
  });

  check('agent-tools: the CLI exits 0 on the live copy, 1 on a write tool, 1 when verifier.md is missing', () => {
    const copy = (name, mutate) => {
      const d = join(DIR, name);
      mkdirSync(d, { recursive: true });
      for (const f of readdirSync(AGENTS).filter((x) => x.endsWith('.md'))) writeFileSync(join(d, f), readFileSync(join(AGENTS, f), 'utf8'));
      mutate?.(d);
      return d;
    };
    const good = cli(copy('good'));
    assert(good.status === 0 && /AGENT TOOLS OK/.test(good.stdout), `good copy: ${good.status} ${good.stdout.slice(-300)}`);
    const bad = cli(copy('bad', (d) => writeFileSync(join(d, 'verifier.md'), addTool(live('verifier'), 'mcp__claude_ai_Linear__save_issue'))));
    assert(bad.status === 1 && /write-tool/.test(bad.stdout), `write tool: ${bad.status} ${bad.stdout.slice(-300)}`);
    const gone = cli(copy('gone', (d) => rmSync(join(d, 'verifier.md'))));
    assert(gone.status === 1 && /verifier\.md missing/.test(gone.stdout), `missing verifier: ${gone.status} ${gone.stdout.slice(-300)}`);
  });
}
