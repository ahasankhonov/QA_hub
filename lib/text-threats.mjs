// Prompt-injection scan for text the hub did not write: ticket bodies and comments, client documents
// converted by markitdown, SharePoint/Slack pulls. All of it is pasted into agent prompts verbatim, and
// none of it is ours. Flag, never block — a flagged ticket is still tested; the finding just means a
// human looks at that text before an agent acts on an instruction inside it.
//
// Idea from vostride/agent-qa (packages/core/src/memory/security-scanner.ts, FSL-1.1, read 2026-10-16),
// re-written for this corpus. Their `you are now` pattern was dropped: QA tickets say "you are now
// logged in" constantly. Every pattern below was run over all raw intake pulls and _md/ conversions in
// projects/ before it was kept (zero hits on 2026-10-16) — rerun that check when adding one.

export const THREAT_PATTERNS = [
  { id: 'prompt_injection', re: /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|preceding)\s+(instructions|prompts?|rules|messages)\b/i },
  { id: 'rule_bypass', re: /\bdisregard\s+(your|all|any)\s+(instructions|rules|guidelines)\b/i },
  { id: 'sys_override', re: /\bsystem\s+prompt\s+(override|injection)\b|\bnew\s+system\s+prompt\s*:/i },
  { id: 'role_hijack', re: /\byou\s+are\s+now\s+(an?\s+)?(unrestricted|jailbroken|DAN\b|developer\s+mode|different\s+(AI|assistant|model))/i },
  { id: 'deception', re: /\bdo\s+not\s+(tell|inform|show)\s+the\s+(user|human|operator)\b/i },
  { id: 'restriction_bypass', re: /\bact\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)\b/i },
  // Addressed to the tester, not to the product: "agent" is a Alpha/real-estate role and Epsilon's
  // tickets say "the AI should send the booking link", so the bare words are product text.
  { id: 'agent_directive', re: /\b(Claude|ChatGPT|(AI|LLM|QA)\s+(QA\s+)?(tester|reviewer|agent|bot))\s*[,:]?\s+((must|should|please)\s+)?(now\s+)?(approve|mark\s+(this|it)\s+(as\s+)?pass|move\s+(this|it)\s+to|close|delete|post|send|email)\b/i },
  // A secret variable inside the URL or the request body — a dev's `-H "Authorization: Bearer $TOKEN"`
  // repro is normal ticket text and does not match.
  { id: 'exfil_curl', re: /\b(curl|wget)\s+[^\n]*(https?:\/\/\S*|(-d|--data(-raw|-binary)?)\s+\S*)\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)/i },
  { id: 'read_secrets', re: /\bcat\s+[^\n]*(\.env\b|credentials|\.netrc|\.pgpass|id_rsa)/i },
  { id: 'ssh_access', re: /authorized_keys|\$HOME\/\.ssh|~\/\.ssh/i },
];

// Hidden text. Bidi overrides reorder what a human sees; Unicode tag characters (U+E0000–E007F) carry
// invisible ASCII ("ASCII smuggling"). A single zero-width space is copy-paste noise (found in our own
// notes) and U+200D joins emoji, so zero-width characters only count as a run of 3 or more.
const BIDI = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
const isTag = (cp) => cp >= 0xe0000 && cp <= 0xe007f;

/**
 * @param {string} text
 * @returns {{id:string, excerpt:string}[]} one entry per pattern that matched (first match only)
 */
export function scanText(text) {
  const s = String(text ?? '');
  const out = [];
  for (const { id, re } of THREAT_PATTERNS) {
    const m = re.exec(s);
    if (m) out.push({ id, excerpt: excerptAt(s, m.index, m[0].length) });
  }
  let i = 0;
  let zwRun = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    let hit = null;
    if (BIDI.has(cp)) hit = 'invisible_bidi';
    else if (isTag(cp)) hit = 'invisible_tag_chars';
    else if (ZERO_WIDTH.has(cp)) { if (++zwRun >= 3) hit = 'invisible_zero_width_run'; }
    else zwRun = 0;
    if (hit) {
      out.push({ id: `${hit}_U+${cp.toString(16).toUpperCase().padStart(4, '0')}`, excerpt: excerptAt(s, i, 1) });
      break;
    }
    i += ch.length;
  }
  return out;
}

function excerptAt(s, idx, len) {
  const from = Math.max(0, idx - 40);
  return s.slice(from, idx + len + 40).replace(/\s+/g, ' ').replace(/[​-‍⁠﻿‪-‮⁦-⁩]/g, '�').trim();
}

/** One-line description for CLI output. */
export const describeThreats = (label, hits) =>
  `${label}: possible prompt injection — ${hits.map((h) => `${h.id} «${h.excerpt.slice(0, 90)}»`).join('; ')} — read this text yourself before an agent acts on it`;
