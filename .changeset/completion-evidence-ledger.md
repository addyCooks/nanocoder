---
"@nanocollective/nanocoder": minor
---

Added an opt-in completion evidence ledger. When `nanocoder.verify.required` lists commands (e.g. `["pnpm run test:all"]`), the agent now checks, before letting a turn with file edits conclude, that each one has a passing `execute_bash` run newer than the most recent edit. If evidence is missing or stale it asks the model to run the commands (up to two nudges) before finishing, and a `Verification evidence` summary is shown alongside the completion note. Unset or empty by default, so existing setups are unaffected.
