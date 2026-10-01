# slack-qa-bot

A Slack bot that hands out QA tasks for Salesforce Marketing Cloud work. Someone runs `/qa`, fills in a form, and the bot posts the task for the assignee to accept. On accept, it copies the Google Sheets QA checklist for that type of task and shares it with them.

It can also run an **automated first pass** on the work being QA'd, if the requester attaches it (a preview URL, an HTML file, pasted HTML, or a journey/automation export):

- **Emails: Jeff, on TypeSafe's Jev model.** When the QA sheet is created, every question in it is checked against the email. Two columns are added next to the questions: "Review Results by Jev" (Pass, Fail, Unsure or N/A) and a hidden "Jev Results" column with the probabilities.
- **Journeys and automations: Claude.** It reviews the export against the checklist. The findings go in the task's Slack thread and in a "Claude review" tab of the QA sheet.

The assignee still does the QA and makes the final call.

It runs as a Cloudflare Worker.

## How it works

1. `/qa` opens a "New QA Task" form with these fields:
   - assignee (members of the channel);
   - project name;
   - QA type (one per checklist template);
   - deadline;
   - notes.

   When Claude is configured, there are also optional review fields: a preview or CloudPage URL, up to 3 files (`.html`, `.md`, `.txt`), or up to 3,000 characters of pasted text.
2. **On submit,** the bot posts the task in the channel with **Accept** and **Reject** buttons for the assignee. If review material was attached, a background review starts in that message's thread.
3. **Accept:**
   - The bot copies the QA type's Google Sheet template into the folder above the template's folder, named `<deadline> - <project> - <QA type> QA`.
   - It shares the copy with the assignee and adds the link to the message.
   - Duplicate clicks are ignored, using KV (`TASK_STATE`).
4. **Reject** marks the task as rejected. Only the assignee can accept or reject.

### Jeff (emails)

Jeff runs when the assignee accepts and the QA sheet has been created, because the questions come from that sheet.

1. **Find the question rows** in every tab of the sheet. A question table is one whose header has a *Check Item*, *Detail* or *Question* column; an *Instruction* column is added to the question, and *Category* carries down to the rows below it. That covers both the "Pre-Deployment Validation" layout and the BETA "QA-Email Send" layout. Tabs without one (Overview, Execution Verification, Post-Deployment Audit) are left alone.
2. **Read the email** into the text-only snapshot Jeff gives Jev:
   - the subject, from the HTML `<title>`;
   - the preheader, from the hidden preview text;
   - the text sections, links, images with their alt text, footer and personalization tokens.

   Raw HTML is never sent to Jev.
3. **Ask Jev two yes/no questions per row:**
   - Does the email pass this check? The check is phrased as a pass statement, because rows are worded both ways ("Is the subject line correct?", "Are there any grammatical errors?").
   - Can this be judged from the email's content alone?

   Questions go 50 per request, four requests at a time.
4. **Write the results:**
   - **Review Results by Jev:** *N/A* when Jev says the row can't be judged from the email (naming, audience counts, sender settings, seed tests). Otherwise *Pass* at 80% or more, *Fail* at 30% or less, and *Unsure* in between. These are Jeff's thresholds.
   - **Jev Results**, hidden: the probabilities, the rule and the model. Jev returns probabilities, not written explanations.

   The template's own Status column is left for the assignee. Running Jeff again on the same sheet reuses the two columns.
5. **Post a summary** in the task thread: the counts, then the failed and unsure rows.

### The Claude review (journeys and automations)

Each task with review material gets its own `ReviewRunner` Durable Object. A review can take a few minutes, longer than Slack waits for a reply, so it runs in the object's alarm. In order:

1. **Read the checklist:** every tab of the QA type's template sheet.
2. **Collect the material:**
   - It fetches the URL (https only).
   - It downloads the uploaded files from Slack.
   - Anything too large or unreadable is skipped, and the thread says so. Nothing is cut short silently.
3. **Ask Claude:** Claude (`claude-opus-5` by default) returns a structured result. That's one line per checklist item (pass, fail, warning or not checked, with the evidence and where it is), plus problems the checklist doesn't cover: broken links, missing alt text, AMPscript mistakes, leftover test copy, journey logic.
4. **Post the findings** in the task thread, failures first.
5. **Write the "Claude review" tab** into the QA sheet, once the sheet exists. The review may finish before or after the assignee accepts; either order works.

The review material is passed to Claude as data, not instructions. Everything Claude writes is escaped before it's posted, so it can't ping `@channel` or disguise links. If Claude declines a request, the API retries it on its recommended fallback model (`fallbacks: "default"`). If the review fails, the thread says so and the task carries on as normal.

## Setup

### Slack app

- **Slash command:** `/qa`, with the Worker URL as the request URL.
- **Interactivity:** on, with the same URL.
- **Bot scopes:**
  - `commands`, `chat:write`;
  - `channels:read` (and `groups:read` for private channels) for the assignee list;
  - `users:read` and `users:read.email` to share the sheet;
  - `files:read` to read files uploaded for review.

### Google

A service account with the Drive and Sheets APIs enabled. It needs to read the template sheets and write to the folder the copies go into. Use one template sheet per QA type; the first tab is the checklist Claude reviews against.

### Worker configuration

| Name | Type | What it is |
|---|---|---|
| `SLACK_BOT_TOKEN` | Secret | Bot user OAuth token |
| `SLACK_SIGNING_SECRET` | Secret | Used to verify requests come from Slack |
| `GOOGLE_SA_CLIENT_EMAIL` | Secret | Service account email |
| `GOOGLE_SA_PRIVATE_KEY` | Secret | Service account private key (PEM) |
| `QA_TEMPLATES` | Text | The QA types: `[{"label": "Email Send", "templateId": "<sheet id>"}, ...]`. Add `"reviewer": "jeff"` or `"claude"` to override the default, which is Jeff for labels containing "Email" and Claude for the rest |
| `JEV_API_KEY` | Secret | TypeSafe API key. Turns on Jeff for email tasks |
| `JEV_MODEL` | Text, optional | Jev model (default `jev-1.13.0`, pinned so results stay comparable) |
| `JEV_BASE_URL` | Text, optional | Jev endpoint, for a mock or proxy (default `https://api.typesafe.ai`) |
| `ANTHROPIC_API_KEY` | Secret | Turns on the Claude review for journeys and automations |
| `CLAUDE_MODEL` | Text, optional | Model for Claude reviews (default `claude-opus-5`) |

The review fields only appear in `/qa` when at least one of the two keys is set. A task is only reviewed when the key for its reviewer is set.

`wrangler.jsonc` binds the `TASK_STATE` KV namespace and the `REVIEWS` Durable Object.

```sh
npm install
npx wrangler secret put JEV_API_KEY         # and ANTHROPIC_API_KEY, and the other secrets
npm run deploy:staging   # a separate slack-qa-bot-staging Worker, for testing
npm run deploy           # the live bot
```

`deploy` keeps variables set in the Cloudflare dashboard. Test changes on staging first: point a test Slack app at the staging Worker's URL.

## Tests

```sh
npm test
```

The tests cover:
- the Claude request (model, structured output, material wrapped as data);
- handling refusals and cut-off responses;
- the Slack report (escaping, ordering, Slack's size limits);
- collecting material (https only, skipped files reported, total size cap);
- reading the checklist and writing the review tab;
- the review runner in both orders (review before or after the sheet), and its failure cases;
- the Worker wiring: review fields shown only when configured, email tasks routed to Jeff and others to Claude, each only with its key;
- **Jeff:**
  - finding questions in both template layouts (rows from the real templates);
  - reading the email (subject, preheader, links, images, footer, tokens);
  - the pass/fail/unsure/N/A rules, and batching 50 questions per request;
  - the Jev client's retries and errors;
  - writing and hiding the columns;
  - waiting for the sheet before running.

Slack, Google, Jev and Claude are stubbed. Nothing calls the real APIs.

## Project structure

```
src/worker.js          Slack handlers: /qa, the form, accept/reject, Google Sheet copy
src/google-auth.js     Service-account token for Drive and Sheets
src/review/runner.js   ReviewRunner Durable Object: runs one task's review
src/review/claude.js   The Claude request, output schema and response handling
src/review/inputs.js   Fetches the URL and Slack files to review
src/review/sheets.js   Reads the checklist; writes the "Claude review" tab
src/review/report.js   Formats the Slack thread reply
src/jeff/jev-client.js The Jev (System One) HTTP client, from SFMC Content Agent
src/jeff/email-state.js Email HTML to the text snapshot Jev reads
src/jeff/sheet.js      Finds the sheet's question rows; writes and hides the result columns
src/jeff/run.js        Two Jev questions per row, thresholds, batching, the Slack summary
tests/                 node:test tests with stubbed APIs
```

## Limitations

- **Tested with stubs only:** neither review has run against a real Slack workspace, Google account, Jev or the Claude API yet. Try it on staging first.
- **Jeff's thresholds aren't calibrated:** they're Jeff's starting values (80% / 30%), and the "can this be judged from the email" question is new here. Check the first real runs against a few known emails.
- **Subject line:** it comes from the HTML `<title>`. If the exported HTML has no title, or a different one, Jev checks the wrong subject (the thread says so when the title is missing).
- **No rendering check:** Claude reads the HTML or the preview page's HTML; it doesn't see how the email renders in Outlook or Gmail. Checklist items like that come back as "not checked".
- **Size limits:** material over about 400,000 characters per item (600,000 in total) is skipped, and the thread says so.
- **Pasted text limit:** Slack caps pasted text at 3,000 characters, so full emails need a file or a URL.
- **Private previews:** the URL must be reachable from the internet. Pages behind a login can't be fetched.

## History

Before July 2026 this was a Node app using `@slack/bolt` (see `index.js` in git history). It kept task state in memory and ran on Heroku.
