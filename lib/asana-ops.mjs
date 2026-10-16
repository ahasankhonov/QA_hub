// Asana call construction — the Asana half of what lib/jira-ops.mjs does for Jira. R-01/R-04.
//
// gamma tracks in Asana: four boards (projects), each with the same column names but its own
// section gids. The write gate is tracker-agnostic (it hashes whatever call it is handed); only the
// *shape* of the call is tracker-specific, and that shape lives here so exactly one file knows it.
//
// Three things Asana forces on us:
//
//  1. A column is a *section*, and section gids are per board. "Release Candidate" on the Survey &
//     QC board is a different gid from "Release Candidate" on the Reporting board. So a move needs
//     the task's board, which only the live pull knows — a ticket with no live record is refused.
//
//  2. The ledger speaks GAM-<n>; the API speaks task gids. The live pull carries the mapping.
//
//  3. Tool and argument names are never hard-coded here. The profile pins each tool's name AND its
//     argument names, read once off the connector's schema, and records when that was done
//     (`toolsVerifiedAt`). Without that stamp nothing is planned: a guessed argument name is a call
//     that fails at replay after the user already approved it, or worse, one that succeeds with a
//     field nobody meant. The schema read on 2026-10-06 showed the connector has NO tool that moves
//     an existing task to a section, so moves can be routed to a human instead (see isManualMove).

/**
 * The project's Asana block, fully checked.
 * @returns {object} profile.asana
 * @throws {Error} naming the missing key
 */
export function asanaConfig(profile) {
  const a = profile?.asana;
  if (!a || typeof a !== 'object') throw new Error('profile has no "asana" block');
  const need = (path, value) => {
    if (value === undefined || value === null || value === '' || /^TODO/i.test(String(value)))
      throw new Error(`profile.${path} is missing`);
  };
  need('asana.workspaceGid', a.workspaceGid);
  need('asana.toolsVerifiedAt', a.toolsVerifiedAt);
  if (a.moveMode !== undefined && a.moveMode !== 'tool' && a.moveMode !== 'manual')
    throw new Error(`profile.asana.moveMode must be "tool" or "manual", not ${JSON.stringify(a.moveMode)}`);
  // "manual" is an explicit opt-in, never a fallback: a profile that just lacks a move tool is refused.
  for (const k of isManualMove(a) ? ['comment'] : ['comment', 'move']) {
    need(`asana.tools.${k}.name`, a.tools?.[k]?.name);
    for (const arg of k === 'comment' ? ['task', 'text'] : ['task', 'section'])
      need(`asana.tools.${k}.args.${arg}`, a.tools?.[k]?.args?.[arg]);
  }
  const boards = a.boards && typeof a.boards === 'object' ? Object.entries(a.boards) : [];
  if (boards.length === 0) throw new Error('profile.asana.boards is missing');
  for (const [name, b] of boards) {
    need(`asana.boards["${name}"].projectGid`, b?.projectGid);
    if (!b.sections || Object.keys(b.sections).length === 0) throw new Error(`profile.asana.boards["${name}"].sections is missing`);
  }
  return a;
}

/**
 * True when column moves are done by a human from the plan's manualMoves list, not by a tool call.
 * The claude.ai Asana connector (verified 2026-10-06) has no tool that moves an existing task to a
 * section, so gamma runs with moveMode "manual".
 */
export function isManualMove(asana) {
  return asana?.moveMode === 'manual';
}

/**
 * Board + column name → section gid. No fallback: an unknown board or column is a profile that has
 * not been read off the real workspace, not a section to improvise.
 */
export function sectionGidFor(board, column, asana) {
  const b = asana?.boards?.[board];
  if (!b) throw new Error(`unknown Asana board "${board}" (profile.asana.boards has: ${Object.keys(asana?.boards || {}).join(', ')})`);
  const gid = b.sections?.[column];
  if (gid === undefined || gid === null || gid === '' || /^TODO/i.test(String(gid)))
    throw new Error(`no section gid for column "${column}" on board "${board}" in profile.asana.boards`);
  return String(gid);
}

/** The comment (story) call for one task. */
export function commentOp(taskGid, text, asana) {
  const t = asana.tools.comment;
  return { tool: t.name, args: { [t.args.task]: String(taskGid), [t.args.text]: text } };
}

/** The call that moves one task into `column` on its own board. */
export function moveOp(taskGid, board, column, asana) {
  const t = asana.tools.move;
  return { tool: t.name, args: { [t.args.task]: String(taskGid), [t.args.section]: sectionGidFor(board, column, asana) } };
}
