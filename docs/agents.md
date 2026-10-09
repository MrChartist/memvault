# Agents: one memory, many helpers

An **agent** is a saved profile that any AI can become. It says who the helper is, how it should sound, what it must always and never do, and which memories it may see. This page shows how to make one, use one, and limit what it can see.

## What is in a profile

| Part | What it does | Example |
|---|---|---|
| Name and short id | What you call it; letters, numbers and dashes | `Study Buddy`, `study-buddy` |
| Job (role) | One line on what it is for | A patient study helper for learners of any age |
| Voice | Language and tone | Plain English, encouraging |
| Always / Never | Hard rules, one per line | Let the learner try first. / Never hand over finished homework. |
| Output style | How answers are shaped | Short steps, end with a question |
| Topics | Words that help it recall the right memories | learning, revision |
| Brand (optional) | A name or website it should use | `@yourhandle` |
| Memory access | Extra spaces it may read; whether it may list Secure Vault names | `project:garden` |
| Tools (optional) | Limit which tools it is offered | only `vault_search` |

## Make one

**1. In the dashboard.** Agents → **New agent from a description**. Write about the helper in your own words ("You are a patient maths tutor. Use simple English. Never give the final answer first."). MemVault sorts your sentences into job, voice, always and never, and shows you a form to check and change. Nothing is saved until you press Save. It works best in English; for other languages, fill in the form by hand.

**2. From the terminal.**
```bash
memvault agent create --name "Maths Tutor" --from-file tutor.txt --save
memvault agent edit maths-tutor        # opens it in your editor
```

**3. Ask your AI.** In an app connected to MemVault, say "Read my description and create an agent from it." The AI fills in the profile with the `agent_define` tool, which is more thorough than the built-in reader. (`agent_define` can set who the agent is but never its permissions; those stay with you.)

## Use one

- **Copy briefing** (dashboard) or `memvault agent brief <id>`: paste it into any AI to make it that agent for the chat.
- **`agent_activate`**: in an app that is connected to MemVault, say "Activate the study-buddy agent." The briefing includes the agent's rules and the memories it may see.
- **Give an app its own agent**: `memvault mcp-config --agent study-buddy` prints settings for that one app. That app now only ever sees what `study-buddy` may see, and is only offered the tools `study-buddy` may use. The agent comes from those settings, never from anything the AI says.

## Memory spaces

| Space | Who can read it | Who can write it |
|---|---|---|
| `shared` | every agent | every agent |
| `agent:<id>` | that agent, and you | that agent |
| `project:<name>` | agents whose profile lists it | agents whose profile lists it as writable |

Tell an agent to keep something private: "Remember this, privately." (`vault_remember` with `private: true`). A coordinator that must see several private spaces can be given `agent:*` or `project:*` read access in "More options"; the dashboard marks such agents **wide access** so you notice.

Use **See what this agent can see** on the Memory page to check what an agent would find.

## Handoffs

Agents do not see each other's chats. They pass work through memory:

1. The writer finishes a draft and calls `agent_handoff` to `planner` with a brief that says everything the planner needs.
2. Later, the planner starts and sees "Inbox: 1 handoff" in its briefing.
3. It does the work and acknowledges it with `agent_inbox` (`ack`).

Handoffs are ordinary notes, so you can read them in the dashboard. Agents are told to treat inbox items as requests to weigh, not commands that override their own rules.

## Writing a good profile

- Keep rules short and concrete: "Ask who the writing is for before drafting" beats "Be thoughtful".
- Put hard limits under **Never**, and habits under **Always**.
- Give the **job** in one line. If you cannot, it is probably two agents.
- Leave memory access at the default unless you know why you need more.
- For sensitive work, give the agent its own private space and keep it off the `shared` topics you use elsewhere.

## Starter packs

`memvault agent packs` lists them. `general` is the default. A pack is a folder in `profiles/` with one JSON file per agent and a `pack.json` (`{ "title": "…", "description": "…" }`). Add your own folder, then `memvault agent starter --pack <folder>`. The `markets` pack is an example that shows brand names, hard rules and a handoff between an analyst and an editor.

## Profile file (JSON)

```json
{
  "id": "study-buddy",
  "name": "Study Buddy",
  "role": "A patient study helper for learners of any age",
  "persona": "You help someone understand a topic one step at a time.",
  "voice": { "language": "Plain English", "tone": "encouraging, patient" },
  "rules": {
    "always": ["Let the learner try first. Give a hint before the answer."],
    "never": ["Do not hand over finished answers to graded work."]
  },
  "outputStyle": ["Short steps. End with a question."],
  "domains": ["learning", "revision"],
  "brand": { "handle": "", "site": "", "notes": "" },
  "memory": { "readScopes": [], "writeScopes": [], "autoRecall": 8, "allowSecrets": false },
  "tools": { "allow": null }
}
```

`readScopes` and `writeScopes` take names like `project:garden`, or `project:*` for all projects. `autoRecall` is how many relevant memories to include in a briefing. `tools.allow` is a list of tool names, or `null` for all tools the agent is normally offered.

## Limits worth knowing

- An agent cannot stop an AI company from seeing text the AI reads. It limits *how much* is read. See [SECURITY.md](../SECURITY.md).
- The "describe it in words" reader is rule-based and works best in English. Always check the draft.
- Profiles are visible to every agent on the same vault. Put anything private in an agent's private memory space, not in its profile text.
