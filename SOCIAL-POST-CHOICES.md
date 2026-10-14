# Choosing your own events

Added 13 October 2026. The approval email is now a **chooser**: it lists every
candidate event for every day, with the ones the system picked already ticked,
and you can swap an event out before approving.

## How it behaves

**You change nothing** → the post goes out exactly as before, using the image
already published. Nothing extra happens.

**You change something** → the post is **rebuilt**, not published. A new image
is drawn and a **second email** arrives to approve that one.

That is the whole design. The image has the events printed on it, so publishing
your new list against the old picture would put words on Facebook that are not
in the image. Rebuilding means the picture and the words always agree, and you
always approve the thing you are actually looking at.

## How many events

| Post | Days | Per day | Total |
|---|---|---|---|
| **Weekly** | Mon–Fri | exactly 1 | 5 |
| **Weekend** | Fri–Sun | 1, sometimes 2 | up to 6 |

The page shows a live count — "3 of 5 ticked" — and turns red if you go over.

## Seeing what you missed

A new tab, **Post Options**: every candidate for every post, marked **Chosen**
or **Not chosen**, with the category, rank and venue size that decided it. Run
`writeAllPostOptions` from the Apps Script function list to build it.

---

# SETUP — needed once

Four steps. Steps 1 and 2 are Apps Script; 3 and 4 are GitHub.

## 1. Create the token

At **github.com/settings/tokens** → **Fine-grained tokens** → **Generate new
token**.

- **Resource owner**: **the organisation** (`local-folk`) — not your personal
  account. A fine-grained token only reaches repositories belonging to the
  account it was created under, so an org repo is invisible to a personal token.
- **Token name**: `The Kirn - social rebuild`
- **Expiration**: 90 days (it will remind you; nothing breaks if you let it lapse
  except event swapping)
- **Repository access**: select **Only select repositories** → choose **The Kirn**
- **Permissions → Repository permissions → Actions**: **Read and write**
- **Everything else**: leave alone

Click **Generate token** and copy it. It is shown once.

### Why Actions, and not Contents

GitHub's REST reference is specific about which permission each trigger needs:

| Trigger | Endpoint | Fine-grained permission |
|---|---|---|
| `repository_dispatch` | `POST /repos/{o}/{r}/dispatches` | **Contents: write** |
| `workflow_dispatch` | `POST /repos/{o}/{r}/actions/workflows/{id}/dispatches` | **Actions: write** |

This project uses **`workflow_dispatch`**, so the token can start a build and
nothing else — it cannot push code to the repository, rewrite the site, or read
your spreadsheets. That narrowness is the entire security argument for sending
the choices by a published sheet rather than in the repository.

**Setting Actions:write while a `repository_dispatch` call is in use fails every
time**, and re-saving the permission changes nothing:

```
403 {"message":"Resource not accessible by personal access token"}
```

Observed 14 October 2026. Run `githubTokenCheck` in Apps Script to tell the two
causes apart — it tests a plain read first, then the real dispatch.

## 2. Add the script properties

In Apps Script → **Script properties** → add:

| Name | Value |
|---|---|
| `GITHUB_TOKEN` | the token from step 1 |
| `GITHUB_REPO` | `your-username/the-kirn-repo` |
| `POST_CHOICES_SPREADSHEET_ID` | the ID of Kirn Post Choices — see 3b |

`GITHUB_REPO` is literally `owner/name`, no `.git`, no URL.

## 3. Publish the choices spreadsheet

**It must be a SEPARATE spreadsheet, not a tab of The Kirn.**

This is not tidiness — it is a repair. On 14 October 2026 the Post Choices tab
was published from The Kirn, which **silently revoked public access to the
events tab** and stopped the website's event pages regenerating (HTTP 401).
Google publishes **one tab at a time**; two tabs of one document cannot both be
readable. Two *documents* have no such conflict.

So, using the new blank **Kirn Post Choices** spreadsheet:

1. Delete the **Post Choices** tab from The Kirn spreadsheet. Nothing reads it
   any more, and leaving it invites the same mistake again.
2. In **Kirn Post Choices**, **File → Share → Publish to web**.
3. Select **Entire document** — safe, because the sheet contains nothing but
   post IDs, a timestamp and event names.
4. **Publish** and copy the URL. It looks like:
   `https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?gid=0&single=true&output=csv`

**Do not touch The Kirn's publishing again.** Its events tab is already
published and the website depends on it.

## 3b. Add the spreadsheet's ID

Apps Script → **Project Settings** → **Script properties** → add:

| Name | Value |
|---|---|
| `POST_CHOICES_SPREADSHEET_ID` | the spreadsheet's ID |

To find the ID: open **Kirn Post Choices**, and look at the URL —
`docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`. Copy just that part.

With this set, the choices are written to that spreadsheet. Without it they fall
back to a `Post Choices` tab in The Kirn, which works but cannot be published
alongside the events tab — so the website's event pages break. The fallback
exists so an existing setup keeps working; it is not the arrangement to use.

## 4. Add the URL to the repository

On GitHub: **Settings → Secrets and variables → Actions → New repository
variable**

- Name: `POST_CHOICES_URL`
- Value: the URL from step 3

It is a **variable**, not a secret — the sheet contains only event names and
dates, which are published on the site anyway.

---

## What the token can and cannot do

| | |
|---|---|
| Start a workflow run | ✅ |
| Read or alter your code | ❌ |
| Read or alter the site | ❌ |
| Read or alter the spreadsheets | ❌ |
| Do anything else | ❌ |

Worst case if it leaked: someone could start a build. It cannot change anything.

## If it goes wrong

**The post still posts normally.** Event swapping is an addition; if the token,
the sheet or the URL is missing, approving without changing anything works
exactly as it always did.

**"Choices saved" but no second email arrives** — check the Actions tab for a
failed run. The usual cause is `POST_CHOICES_URL` unset, so the workflow could
not see which events you wanted.

**The row is in the sheet, but the rebuild still used the old events** — this is
Google's cache, not a bug in your setup. A published CSV is served with
`Cache-Control: private, max-age=300`, so it can be up to **five minutes stale**.
Apps Script writes your choice and starts the rebuild within about a second of
each other, so an immediate read returns the sheet as it was *before* you pressed
Approve. Nothing errors and no email arrives. Observed 14 October 2026.

This is now handled for you. `requestRegeneration_` schedules the rebuild **six
minutes after** you press Approve rather than firing it at once, so the sheet has
always settled by the time the workflow reads it. The approval page tells you the
wait is coming.

Two things to expect:

- The second email arrives about **seven or eight minutes** after you approve,
  not "shortly". That is normal.
- If the rebuild cannot start at all, you get an email saying so. Every earlier
  failure in this feature announced itself by being silent, so this one is loud.

If you change your mind mid-wait and approve again, the waiting rebuild is
replaced rather than doubled — you still get one email, built from your newest
choice.

**Still no second email?** Run **`retryPendingRebuildEmails`** from the editor.
It finds any rebuilt post whose send never confirmed and emails it again — no
arguments, no PostID to look up. It runs automatically at the end of the daily
draft run too, so this is a backstop rather than a routine step.

If it says *"No rebuilt post is waiting to be emailed"*, the email did go out and
the problem is delivery rather than the script.

Check the Apps Script executions for `runScheduledRebuild_` and then
`runScheduledDraft_`. Both should have run, and `runScheduledDraft_` should show
a `Sending the approval email to …` line and then `Approval email sent for …`.
It works on any day of the week — the Monday/Friday rule is deliberately bypassed
for a rebuilt post, because you are waiting by the inbox for it.

If either execution is missing from the list, the trigger never fired; run
`createSocialTriggers` once to reinstall them (that also clears and recreates the
daily triggers, so run it before a live posting day if you can).

**The page still shows the old style** — `Candidates` is not in the deployed
queue file yet. The workflow adds it on its next run.

## Files

| File | Role |
|---|---|
| `select-social-events.js` | writes every candidate into `social-posts.json` |
| `build-captions.js` | carries them into `social/queue.json` (capped at 12/day) |
| `apply-choices.js` | applies your choices on a rebuild, waiting out the sheet cache |
| `generate-social-images.js` | unchanged — it draws whatever `rows` says |
| `.github/workflows/generate-social-images.yml` | gained `workflow_dispatch` |

**`social/queue.json`, `social/posted.json` and `social/archive/` must not be
committed by hand** — the workflow owns them, and the local copies are behind.