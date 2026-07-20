Run exactly one Agent lifecycle operation: spawn a new session now, resume an existing durable session, or schedule a future run. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
{{typeList}}

Custom agents can be defined in .pi/agents/<name>.md (project) or {{agentDir}}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

Use the required `operation` object: `kind: "spawn"` requires `prompt` + `subagent_type`; `kind: "resume"` requires `agent_id` + `prompt`; `kind: "schedule"` requires `schedule` + `prompt` + `subagent_type`.

## When not to use

If the target is already known, use a direct tool — `read` for a known path, `grep`/`find` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- A short description is useful UI metadata but optional; Agent derives one from the prompt when omitted.
- For parallel work, send multiple Agent calls in one message with `operation.run_in_background: true` on each. Foreground calls run sequentially.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- Background completion is delivered automatically — do not poll or sleep waiting for it.
- Foreground is the spawn default; scheduled jobs always run in background.
- Use `operation.kind: "resume"` with `agent_id` to continue a durable session after restart. Spawn always starts a fresh session.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Omit `model` and `thinking` on spawn/schedule to inherit the main identity. Resume always reuses its original identity.
- Spawn uses `session_persistence: "durable"` by default. Use `"memory"` for a process-local child conversation: it writes no Agent session/index/transcript and cannot resume after Pi exits.
- Nested delegation is bounded by maxTreeLevels (default 3, counting the main agent as level 1). A maximum-level agent does not receive Agent tools; never try to bypass the limit.
- Use `operation.inherit_context` on spawn when the child needs the parent conversation history.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications). The worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result.{{scheduleGuideline}}

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
