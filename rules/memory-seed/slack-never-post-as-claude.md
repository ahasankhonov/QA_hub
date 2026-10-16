---
name: slack-never-post-as-claude
description: "Never send Slack (or Teams/Telegram) messages on the QA lead's behalf through the connector — they appear as the Claude app, not as the QA lead; \"do them for me\" / \"post them\" means prepare copy-paste texts, the QA lead posts himself"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 0030be74-11c4-4321-81ce-6166e33ee23e
  modified: 2026-10-09T05:30:11.253Z
---

On 2026-10-09 the QA lead reviewed three replies for #gamma-internal, said "can you do them for me?" and then "approved, post all three". I sent them via the claude.ai Slack connector. They showed up as the Claude app ("@Claude"), not as the QA lead, in front of the Gamma dev team. the QA lead: "i don't want sent using @cloud !!!" He had to delete them and repost by hand.

**Why:** The connector posts as the Claude app, and the hub's approval flow made it look like a tracker write (plan → quote → send), which hid that the *sender identity* was wrong. The team channel is the QA lead's voice; a bot posting his EOD and his commitments to the PM is not acceptable.

**How to apply:**
- Never call `slack_send_message` / `teams_send_*` / Telegram reply with the QA lead's personal messages, replies, EOD updates or commitments. Not even with an approved plan — the R-01 gate guards *what* is written, not *who appears to write it*.
- "Do them for me", "post them", "send them" → produce the final texts in code blocks (one per message, with where to post), and say "paste these yourself; the connector would post as the Claude app".
- Only exception: the QA lead explicitly says the message should come from the Claude app/bot (e.g. a bot-labelled QA report in a dev channel) — then plan + approve as usual.
- Related: [[linear-write-approval]], [[qa-ticket-comments-self-contained]].
