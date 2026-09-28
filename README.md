# slack-qa-bot

A Slack bot that hands out QA tasks. Someone runs `/qa` in a channel, fills in a form, and the bot copies a Google Sheets QA checklist for that type of task, shares it with the assignee and the requestor, and posts it to the channel. The assignee can accept or reject the task, and a rejected task can be reassigned.

It is for a team that tracks QA work in checklist spreadsheets and wants the handoff to happen in Slack.

## Features

- `/qa` slash command opens a "QA Submission" modal with:
  - Assignee (members of the current channel)
  - Project name
  - QA type (one option per entry in `GOOGLE_TEMPLATE_IDS`)
  - Deadline date and time
  - Notes (optional)
- On submit, the bot:
  - copies the Google Sheet template for the chosen QA type into a Drive folder, named `<date> <time> - <project> - <QA type> QA`;
  - gives the assignee and requestor edit access to the copy;
  - joins the channel if needed and posts a message that mentions the assignee and links the sheet;
  - sends the assignee an ephemeral message with **Accept** and **Reject** buttons.
- **Accept** posts that the assignee accepted the task.
- **Reject** posts that the task was rejected and sends the requestor an ephemeral **Re-Assign** button.
- **Re-Assign** opens a modal pre-filled with the previous assignee, deadline and notes. Submitting it posts an updated message and sends the new assignee Accept and Reject buttons.
- Drive copies retry with exponential backoff when Google returns `userRateLimitExceeded`.

## How it works

- Built on `@slack/bolt` with an `ExpressReceiver`, so Slack sends commands, interactions and events to `POST /slack/events`.
- Google Drive access uses a service account (`googleapis`, Drive v3, full `drive` scope). Copies and permissions use `supportsAllDrives`, so shared drives work.
- Everything is in `index.js`. There is no database. Task details are held in memory between steps.

## Setup

Prerequisites:

- Node.js 18 (`engines.node` is `18.x`).
- A Slack app with:
  - a slash command `/qa` pointing at `https://<your-host>/slack/events`;
  - Interactivity enabled with the same request URL;
  - bot scopes for what the code calls: `commands`, `chat:write`, `channels:join`, `channels:read` (and `groups:read` for private channels) for `conversations.members`, `users:read`, `users:read.email` and `users.profile:read`.
- A Google Cloud service account with the Drive API enabled. It needs read access to the template sheets and write access to the destination folder.
- One Google Sheet template per QA type.

Install and run:

```sh
npm install
npm start        # node index.js
```

`index.js` also requires `express` and `body-parser`. They are not listed in `package.json` and currently come in through `@slack/bolt`.

### Environment variables

| Name | Purpose |
| --- | --- |
| `SLACK_BOT_TOKEN` | Slack bot user OAuth token |
| `SLACK_SIGNING_SECRET` | Slack signing secret, used to verify requests |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | The service account key JSON, as a single string |
| `GOOGLE_TEMPLATE_IDS` | JSON object mapping a QA type key to a Google Sheet file ID. Keys become the dropdown options, with underscores turned into spaces and words capitalized |
| `COPY_INTO_FOLDER_ID` | Google Drive folder ID where the copies go |
| `PORT` | HTTP port (default 3000) |
| `CONFIG` | Only printed to the log at startup, otherwise unused (an older version used it as a key file path) |

Example shape for `GOOGLE_TEMPLATE_IDS` (placeholder IDs):

```json
{ "email_build": "<sheet-file-id>", "journey_setup": "<sheet-file-id>" }
```

The code reads `process.env` directly and does not call `dotenv`, so set the variables in your shell or hosting platform. `.gitignore` excludes a file named `env.config`.

## Usage

1. Invite the bot to the channel. For public channels it also tries to join by itself when a form is submitted.
2. Run `/qa` in the channel and fill in the form.
3. The assignee clicks **Accept** or **Reject** in the ephemeral message.
4. On reject, the requestor clicks **Re-Assign** and picks a new assignee or deadline.

## Deployment

The previous README recorded a Heroku deployment:

- App: `https://slack-qa-bot-da8758f719e8.herokuapp.com/`
- Slack request URL: `https://slack-qa-bot-da8758f719e8.herokuapp.com/slack/events`

There is no Procfile. Heroku runs `npm start` by default.

## Project structure

```
index.js       The whole bot: Slack handlers, Drive helpers, server start
package.json   Dependencies and start script
```

## Status and known limitations

- Task state (assignee, project, deadline, notes, sheet link) is kept in module-level variables. Two people using `/qa` at the same time will overwrite each other's data, and the Re-Assign modal may pre-fill values from a different task. Restarts lose it.
- The reassigned-task message does not include the sheet link, and the sheet is not shared with the new assignee.
- If the Drive copy fails, the error is logged but the handler then fails when building the sheet link, so nothing is posted to Slack and the user gets no feedback.
- The accept message is posted as the clicking user's own acceptance. The variable is named `requestorId` but it holds the assignee.
- Opening the modal calls `users.info` once per channel member, which is slow and can hit Slack rate limits in large channels. Slack also caps static select menus at 100 options.
- The bot logs user emails, the full request object on `POST /`, and the value of `CONFIG` at startup. Check that logs do not leak anything sensitive.
- No tests.

## Ideas

- Store each task by message or sheet ID (for example in a small database) instead of globals.
- Use Slack's `users_select` element instead of building the member list by hand.
- Share the sheet with the new assignee on reassign and include the link.
- Report Drive errors back to the requestor.
