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

- **Token name**: `The Kirn - social rebuild`
- **Expiration**: 90 days (it will remind you; nothing breaks if you let it lapse
  except event swapping)
- **Repository access**: select **Only select repositories** → choose **The Kirn**
- **Permissions → Repository permissions → Actions**: **Read and write**
- **Everything else**: leave alone

Click **Generate token** and copy it. It is shown once.

## 2. Add the script properties

In Apps Script → **Script properties** → add:

| Name | Value |
|---|---|
| `GITHUB_TOKEN` | the token from step 1 |
| `GITHUB_REPO` | `your-username/the-kirn-repo` |

`GITHUB_REPO` is literally `owner/name`, no `.git`, no URL.

## 3. Publish the Post Choices tab

This is what carries your choices from Apps Script to the workflow **without the
token being able to write anything**. It is the reason the token needs only
Actions permission.

1. In your spreadsheet, make sure the **Post Choices** tab exists. It is created
   automatically the first time you change an event — you can also create it
   yourself now with headers `PostID`, `Requested`, `Picks`.
2. **File → Share → Publish to web**.
3. Select **that tab only** (not the whole document), and **Publish**.
4. Copy the URL. It looks like:
   `https://docs.google.com/spreadsheets/d/e/2PACX-.../pub?gid=123&single=true&output=csv`

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

**The page still shows the old style** — `Candidates` is not in the deployed
queue file yet. The workflow adds it on its next run.

## Files

| File | Role |
|---|---|
| `select-social-events.js` | writes every candidate into `social-posts.json` |
| `build-captions.js` | carries them into `social/queue.json` (capped at 12/day) |
| `apply-choices.js` | **new.** Applies your choices on a rebuild |
| `generate-social-images.js` | unchanged — it draws whatever `rows` says |
| `.github/workflows/generate-social-images.yml` | gained `repository_dispatch` |

**`social/queue.json`, `social/posted.json` and `social/archive/` must not be
committed by hand** — the workflow owns them, and the local copies are behind.