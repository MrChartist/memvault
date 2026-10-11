# Your profile: one place that knows you

Every AI app you connect starts from zero. The profile fixes that: a short list of facts about **you** (how you like things written, what you work on, which tools you use) kept in your own vault and offered to every connected AI app. You say it once.

It lives on your computer. Nothing here is sent anywhere by MemVault. (An AI app that reads your profile sends what it read to its own company, like anything you type to it. See [SECURITY.md](../SECURITY.md).)

## What goes in

A profile holds facts under ten headings. The list is closed on purpose.

| Heading | Examples |
|---|---|
| `identity` | the name you go by, your role, languages, your city |
| `work` | your field, your audience |
| `projects` | what you are building and why |
| `tools` | software, languages and services you use |
| `preferences` | format, length, tone, defaults |
| `communication` | how you write and prompt, names and terms you use, brand voice |
| `goals` | what you are working towards |
| `schedule` | when you are active |
| `interests` | topics you keep coming back to |
| `learning` | what you are studying |

**Not kept, by design:** health, money, ID numbers, passwords, other people's details, beliefs. A value that looks like a password, key or ID number is refused, not stored in masked form. Each fact is one short line (600 characters at most).

## Using it

```bash
memvault profile set preferences writing-tone "short, formal, plain English"
memvault profile set work role "market research analyst"
memvault profile show                       # everything, grouped
memvault profile facets                     # the ten headings
memvault profile remove preferences writing-tone
memvault profile export profile.json        # and: memvault profile import profile.json
memvault profile clear --yes                # delete the whole profile
```

**Learn from your notes.** MemVault can read what is already in your vault and suggest facts: when you are most active, which technologies and topics come up, which tools feed your memory, how long your notes are, which names and terms you dictate. It only counts and measures; there is no model and no network. It starts as a preview:

```bash
memvault profile learn            # shows what it would save; saves nothing
memvault profile learn --apply    # saves it
```

Learning reads only your own notes and imports (not the browser, the clipboard, device scans or file names), only in the shared space (never an agent's private notes), and never overwrites a fact you set by hand. Personal money topics (loans, tax, savings) are never learned.

**A prompt with your background.** Wrap any request, for example one you dictated:

```bash
memvault profile prompt "um so explain the the support and resistance on this chart"
```

It removes fillers ("um", "uh", "you know,") and immediate repeats, and puts your profile above the request, ready to paste into any AI app. It does not rewrite what you said.

## How your AI apps use it

Two MCP tools:

- `profile_get`: returns your profile as background. A **bound agent** (an app limited to one agent) gets a reduced view: no `identity` and no `schedule`, whatever it asks for. Your own full-access connection gets everything.
- `profile_suggest`: an AI can **suggest** one fact, for example a preference you just told it. The suggestion waits. Nothing changes until you accept it:

```bash
memvault profile review           # list what is waiting
memvault profile accept <id>      # or: accept all
memvault profile reject <id>
```

Why suggestions and not writes: the profile is placed into your conversations. If an AI could edit it, a web page or document it read could plant a "fact" (even an instruction) that every other AI would then trust. Only you can accept. At most 25 suggestions wait at a time.

Two more protections: the source names `profile` and `profile-suggestion` are reserved, so no tool, import or API request can create a profile item any other way, and profile items sit in a space that bound agents cannot search. Every change is in the access log (`memvault audit`).

## Wispr Flow

[Wispr Flow](https://wisprflow.ai) turns speech into text. If you use it to write your prompts, MemVault can learn your vocabulary and how much tidying your dictation needs:

```bash
memvault wispr ~/Downloads/wispr-notes/       # a folder, or one file
memvault profile learn
```

The importer reads JSON (a list of notes or meetings) and Markdown or text files. It keeps the text, title and date. It leaves out **attendee names, e-mail addresses and share links** (a share link opens the note for anyone who has it). Running it twice adds nothing twice.

Needs verification: the file the Wispr Flow app itself exports. This version was written against the fields Wispr's notes and meetings carry (`title`, `notes` or `content_excerpt`, `start`), and skips what it does not recognise instead of guessing. If your export does not import, [open an issue](https://github.com/MrChartist/memvault/issues) with the field names (not the content).

## The dashboard and the API

The routes `GET /profile`, `PUT /profile/facts`, `DELETE /profile/facts/:heading/:key`, `POST /profile/learn`, `POST /profile/suggestions/:id/accept`, `.../reject`, `GET /profile/export` and `POST /profile/import` need your access key like every other route. A dashboard page for the profile is not part of this version; use the commands above.
