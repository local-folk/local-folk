# Handover - social posting, 12 October 2026

Written at the end of a long session so the next one can pick up without
re-deriving anything. Read this first, then `SOCIAL-POSTING-SETUP.md` for the
operational steps and `HANDOVER-SOCIAL-POSTING.md` for the original brief.

---

## Rules for this project

**The owner does not have permission to install things or upload by himself.**
An attempt to `npm install @google/clasp` during this session was stopped at the
owner's instruction. Do not install packages, push to GitHub, or push to Apps
Script unless explicitly asked in that same message. Editing local files is
expected and wanted; taking external actions is not.

**Verify against evidence, not memory.** The single biggest time sink in this
project has been giving instructions from memory of how Meta's dashboard behaves.
Every wrong turn came from asserting something plausible without checking. When
the owner reports an error, ask for the **exact text** — paraphrasing has sent
previous attempts in circles.

**Never ask the owner to make a surgical edit in a large file.** Give them a
complete file to copy over, or do the edit in the local copy and tell them to
paste the whole thing.

---

## Where things stand

### Working, and verified

| Thing | State |
|---|---|
| Event selection, ranking, rotation | ✅ |
| Image generation, 1080x1350 | ✅ |
| Background rotation, 11 locked backgrounds | ✅ |
| Caption building, both platforms | ✅ |
| Approval email arrives with image and captions | ✅ **owner confirmed** |
| Approve button → password prompt | ✅ works, owner got the prompt |
| Social tab rows written and status updated | ✅ **owner confirmed** |
| Approval flow tests, 43 of them | ✅ `npm test` |
| The 11:00 posting cutoff | ✅ built and tested, **not yet deployed** |
| Facebook **and** Instagram permissions | ✅ **both READY**, confirmed 12 Oct |
| Instagram linked to The Kirn Page | ✅ `17841475066964633` |
| Token | ✅ **never expires** (System User) |

### Broken right now

**The password submission fails with "script.google.com refused to connect".**

CONFIRMED by the owner on **12 October 2026, desktop browser** — not a phone.
Entering the correct password produces the connection error rather than a page.

The Social tab row *did* update, so the request reached the script and ran. But
the confirmation page never rendered for the owner.

**Ruled out by reading the code:**

1. **A stale deployment URL.** Both the approval link and the form's `action`
   are built from the same `WEB_APP_URL` property (`socialPasswordPage_` and
   `buildApproveUrl_`), so they cannot disagree. This was hypothesis 1 in the
   previous version of this handover and it is wrong.
2. **An exception after the row write.** Both Meta calls are individually
   wrapped in try/catch in `publishOne_`, so a Meta error becomes a page rather
   than an escaping exception.
3. **The dry-run branch.** `SOCIAL_DRY_RUN` unset means dry run **on** — the
   check is `!== 'false'` in both places. Unset does not publish. (The previous
   version of this handover said the opposite.)

**What is left:** the response is generated server-side but not delivered to the
browser. That points at the client — an extension, a password manager on the
`autocomplete="current-password"` field, or a network filter.

**How to diagnose, now instrumented:** `handleSocialPost_` logs
`POST social=approve postId=... nonce=present` as its first statement. Redeploy,
then try the approval and read the Apps Script **Executions** log:

- **The log line appears** — the script ran. The problem is after it. Check the
  browser's Network tab for the POST response status.
- **The log line does not appear** — the request never reached Apps Script. The
  browser or a network layer blocked it. Try a private window with extensions
  disabled.

**Do not** re-run the same approval twice while diagnosing — the nonce is
single-use, so the second attempt will report "no longer valid" and muddy the
result.

### Outstanding

1. **The Meta token — OBTAINED 12 October 2026, not yet stored.** See below.
2. **Nothing is committed or deployed.** The `social.gs` fixes, the cutoff and
   the new test file are local only.

### The token: solved. Root cause was one setting.

**Got working after a long hunt on 12 October.** Full sequence and every wrong
turn is written up in `SOCIAL-POSTING-SETUP.md` section 8 — do not repeat it.

**The single cause:** the app was pointed at the **Instagram API with Instagram
login** use case instead of **API setup with Facebook login**. That wrong choice
caused, in order:

1. Permissions named `instagram_business_*` rather than `instagram_*`.
2. An **Instagram Tester** role being required — impossible for a business the
   owner owns. The owner got added anyway, then hit an unrelated-looking
   `OAuthException` about *future activity history* being switched off.
3. The Facebook Login permissions being **invisible** in the token dialog, which
   surfaced as **"You are not an admin of this app"**.

**The lesson, because it will recur:** that message was *true about the app*
and *misleading about the cause*. The owner was an admin the whole time — the
permissions were not on the app to grant. **Check which use case is active
before touching roles or account settings.**

Two handover claims were wrong and are corrected in the docs:

- **`instagram_content_publish` is not withdrawn.** It is a current Facebook
  Login permission and reads **"Ready for testing"** — Standard access, **no app
  review**, because the app serves only the owner's own business.
- **The Graph API Explorer is still a dead end**, but for the original reason
  (`pages_read_engagement` validation), not because of the permission above.

**Still to do:** the Page assignment (`Assign Assets → Accounts`). Without it
`/me/accounts` returns **zero Pages** and the Instagram account ID cannot be
resolved. Assigning the **app** is not the same as assigning the **Page** — only
the app had been done. **DONE — Page 1391793620674215 "The Kirn".**

**Facebook was then enabled too.** `pages_manage_posts` is a real Meta
permission, but it is **not offered in the token dialog until it has been added
to the use case**: App settings → Use cases → *Manage everything on your Page* →
**Customize** → add `pages_manage_posts`. Only then does it appear in Business
Settings → System Users → Generate new access token. This is Meta's documented
Use Case Permission Mapping and it is the single most confusing part of the
whole setup.

### FIRST LIVE POST 12 October 2026 — Instagram worked, Facebook did not

```
Facebook FAILED: HTTP 403 - (#200) This endpoint is deprecated since the
required permission publish_actions is deprecated [OAuthException] (code 200)
Instagram: posted 18314999917303696
```

**Instagram is confirmed working end to end against the real account.** The
whole chain — queue file, email, approval, password, cutoff, publishing — works.
The first real post went out.

**Facebook's `/me/photos` and `/me/feed` are retired by Meta.** The `/me/...`
form used to resolve to the Page through the token and no longer does. Fixed:
`facebookPagePath_()` now calls `/<FB_PAGE_ID>/photos` and `/<FB_PAGE_ID>/feed`.
The token itself was fine — no permission change is needed, and
**`publish_actions` must not be added**; it no longer exists, which is the
reason Meta deprecated the route.

`FB_PAGE_ID` (Page id `1391793620674215`) must be set in Script Properties. With
it absent the code falls back to `/me` and fails the same way, so the error
message now names the property and points at `check-meta-setup.js`.

**Also confirmed:** the dry-run path works —
`Approved 2026-10-12 21:41 - DRY RUN, nothing posted.`

**Second live attempt failed differently, and revealed the real cause:**

```
Facebook FAILED: HTTP 403 - (#200) Unpublished posts must be posted to a page
as the page itself. [OAuthException] (code 200)
Instagram: posted 17949981771302002
```

This is **not** a permissions problem and **not** the deprecated route. A System
User token is a **User** token. Facebook's two-step photo publish — upload
unpublished, then attach to a post — requires a **Page** token, because an
unpublished photo has to belong to the Page rather than to whoever posts it.

Fixed by `pageToken_()`, which derives the Page token from the stored User token
via `GET /{page-id}?fields=access_token` and caches it in the `FB_PAGE_TOKEN`
script property. Both Graph calls then use the Page token.

**Two separate Facebook bugs, in order, both found only by posting for real:**
1. `/me/photos` is deprecated → use `/<FB_PAGE_ID>/photos`.
2. A User token is refused by the unpublished-photo flow → use a Page token.

Neither would ever have been found by reading the code or by the permissions
check, which reported READY throughout. The Facebook permission has been correct
from the start.

**Third attempt: both platforms posted, but Facebook had no image.** The post
appeared with the caption and no picture, and reported success. Two causes in
`postToFacebook_`, both fixed:

1. **`message` was being sent on the `/photos` step.** Facebook's documented
   two-step puts the caption on the `/feed` call only. Sending it on `/photos`
   makes Facebook treat it as text content of its own, and the post then goes
   out caption-only.
2. **The unpublished photo was attached as `photo`** rather than
   `unpublished_post_id`. `photo` expects a *published* photo object; handing it
   an unpublished one is accepted but the image is not reliably attached — the
   other route to a caption-only post.

This is the failure mode to watch for: **Facebook returns HTTP 200 and a real
post ID for a post that has no image.** A successful call is not proof of a
correct post. Only by looking at the actual Facebook post was this found.

**The broken confirmation page is cosmetic and does not block posting.** It
failed on success and failure alike, so it is not evidence of anything about the
posting path. The Notes column is the reliable record.

**Final state, both READY:**

```
permissions : pages_show_list, instagram_basic, instagram_content_publish,
              pages_read_engagement, pages_manage_posts, public_profile
page        : 1391793620674215 "The Kirn"  <- Instagram linked
IG_ACCOUNT_ID: 17841475066964633
expires     : never
```

Three bugs were found and fixed in `check-meta-setup.js` that day, all from the
same wrong assumption that a System User token's `/me` is a Page.

**`resendApprovalEmail(postId)`** was added the same evening. Approval links are
single-use, and `draftSocialPosts` will not re-email a post it already knows
about — so after any test there was no way to get a second link without hand-
editing Script Properties. This issues a fresh one and publishes nothing.

---

## Meta token: what is ruled out

Do not send the owner down these again. Each was tried and failed.

1. **Graph API Explorer** — fails with `Invalid Scopes: pages_read_engagement`.
   This also happened in a previous session (with `manage_pages` alongside).
   Two sessions, same errors. Treat it as broken.
2. **Instagram Login use case** ("Manage messaging and content on Instagram") —
   requires inviting the account as an "Instagram Tester", and Meta refuses with
   *"Unable to add a user with a role on the app's owning business"*. The owner
   owns the business, so that invitation is permanently impossible. Not a
   misconfiguration.
3. **`instagram_content_publish` is not offered at all** on Facebook-Login apps,
   which Meta has moved away from. Developers are hitting this widely.

> **Item 3 IS WRONG. Do not act on it.** Checked against Meta's documentation on
> 12 October 2026. `instagram_content_publish` **is** a current Facebook-Login
> permission — it is listed in Meta's Permissions Reference with its
> dependencies (`instagram_basic`, `pages_read_engagement`, `pages_show_list`).
> The Instagram App Review page confirms that an app serving *only a business
> the owner owns or manages* runs at **Standard Access with no App Review
> required**, which is this project's case exactly.
>
> The claim appears to have come from developers who *did* need Advanced Access
> (i.e. apps serving other people's businesses) and were told to submit for
> review. The Kirn is not that.
>
> So the System User route below is not "the last hope" — it is the documented,
> intended route, and Facebook Login is the right one to stay on.

**Remaining option:** a **System User** in Meta Business Settings. Its token
never expires, which also removes the 60-day refresh problem entirely. Steps are
in `SOCIAL-POSTING-SETUP.md` section 8a. Untested — the owner may hit another
wall.

**Fallback if Meta stays opaque:** the whole pipeline works up to the button.
The owner can approve from the email, then post by hand. About 5 minutes, twice
a week. This is a legitimate stopping point and worth offering rather than
letting them burn more time.

---

## Content changes made this session

All verified against real data and rendered output.

### Captions

Now exactly as the owner specified:

```
// 12-16 OCT // WEEKLY ROUNDUP

MONDAY - 12/10
Anne Alderson
Bridge Hotel
...
See full list of events on the website.
Link: thekirn.co.uk

#newcastle #northeast #folk #folkmusic #sessions #crafts #markets #thekirn
```

Instagram differs only in the closing line (`Link in bio.`).

The header is built by `post-header.js`, shared between the caption builder and
the image generator, because two implementations of one rule would drift.

### Selection bugs — three separate causes

1. **Rotation history lied.** Events were recorded at *render* time, so a draft
   nobody approved permanently consumed its events. Now reconciled against
   `social/queue.json`.
2. **Tie-break was alphabetical.** "Student Performances" beat "Fresh Thursday"
   purely because S > F. Now prefers named performers over generic listings.
3. **King's Hall outranked Cobalt Studios** on room size. Lowered 5 → 3, at the
   owner's instruction.

Also: `//` in titles was being silently rewritten to `-`. Now preserved.

### Image

- Footer "See full list of events at thekirn.co.uk" **removed** at the owner's
  request
- Subtitle added between wordmark and events, cream not gold
- Wordmark 96px, subtitle 46px, two lines, EB Garamond so dates read properly
- Events render at **scale 0.61** (was 0.59 before any of this)
- `GRID_SAFE` switch at the top of `generate-social-images.js` — set `false` to
  fill the frame (events reach 0.73) at the cost of the wordmark being sliced in
  the Instagram profile grid. Left `true`.

### Backgrounds

11 locked in `social/backgrounds/`, treatment baked in (scrim 0.62 + blur 4),
no text, all 1080x1350. Rotation keyed to **ISO week number**, so consecutive
weeks get the most different colours. Originals preserved in
`social/backgrounds-originals/` (gitignored) so the treatment can be re-tuned.

Ordering maximises the **smallest** neighbour gap, not the total. An earlier
version minimised the total and left two near-identical reds adjacent — the
worst possible outcome for a rotation.

---

### ScheduledFor was labelling posts with the wrong dates

The owner received "Weekly Roundup (Mon 19 Oct, 08:00 UK time)" on an email for
a roundup covering **12-16 October**. Cause:

`nextSlot()` computed ScheduledFor as *the next slot strictly after now*. A
manual run at 13:31 UTC on Monday 12 October was past that Monday's 07:00 slot,
so the date rolled forward to Monday 19 October — while the events, the caption
and the rendered image all still said 12-16 October.

Two changes:

1. **`build-captions.js`** — `nextSlot()` replaced by `scheduledFor()`, which
   derives the date from **the first event in the post**. A label derived from
   the content cannot contradict it, whatever day the workflow runs on. It
   throws rather than inventing a date if the events carry none.
2. **`social.gs`** — the email no longer prints ScheduledFor. It reads the range
   from the caption's own header line (`// 12-16 OCT //`) via
   `dateRangeFromCaption_()`, so the subject, the heading and the image all come
   from one source. Subject is now
   `The Kirn - ready to post: Weekly Roundup (12-16 OCT)`.

Note ScheduledFor is only a label now — the cutoff decides when a post goes out.

### Do not commit the local social/posted.json, queue.json or archive/

These are written by the workflow on the runner, and the local copies are
**behind** what GitHub has. `social/posted.json` holds only 3 entries locally
(all from 9 October) while the runner has recorded every post since. Pushing the
local copy would wipe the rotation history, and the next run would re-pick
events already posted.

**Commit the code and `social/backgrounds/` only.** Let the workflow write
`queue.json`, `posted.json` and `archive/`.

## Venue address, coordinates and links — 13 October 2026

Approving an event in the Pending tab filled in the venue **website** and
nothing else. Address (col I) and Lat/Lng (cols J, K) were left blank unless
someone ran `backfillMissingCoordinates()` by hand.

Now filled automatically from the **Venue Addresses** tab, which has gained
**Latitude (D)** and **Longitude (E)** columns. A venue is geocoded **once** and
cached there; existing values are never overwritten. Full write-up, including a
substring-matching bug that gave *The Cluny 2* The Cluny's website, in
**`VENUE-AUTOFILL.md`**.

`events-venues.test.js` — 21 tests. `npm test` now runs 90.

## ⚠ FINISHED TESTING? Two things to put back

Added 14 October 2026. Both are deliberate test overrides, set by hand.

| Property | Now | Should be |
|---|---|---|
| `DRAFT_WEEKDAYS` | `3,1,5` | **delete it** — back to Monday and Friday emails only |
| `SOCIAL_DRY_RUN` | `true` | **`false`** — or nothing will actually post |

Until `SOCIAL_DRY_RUN` is `false`, approving a post marks it and schedules it
but **publishes nothing**. That is safe, but it means the system is not live.

Also check the Social tab for a leftover `Weekend-161026` row and delete it. If
one survives to Friday, that post counts as already known and **is never
emailed**.

## The rebuilt post was drafted but never emailed (14 October 2026)

The whole chain worked — approve at 13:53, rebuild triggered at 13:59, post
drafted at 14:02 — and no email arrived. `resendApprovalEmail`, run by hand at
14:10, sent the identical email instantly.

So `MailApp` works, the address is right, and the script can send. The failure is
specific to the time-driven trigger context, and **it produced no evidence at
all**: no exception, no failure notice, no log line after "Drafted the rebuilt
post". From inside the script, "sent and lost" and "never sent" were
indistinguishable, and guessing between them is what cost the afternoon.

Fixed by making the send observable rather than by finding the cause, which is
not yet known:

- Log a line **before** and **after** the send, with the recipient and the event
  count. Event count matters — it proves whether the email carried the rebuilt
  list or the old one.
- Write `rebuild-email-pending` into the row's Notes before the send and clear it
  after. A Draft row still carrying that marker is proof the send never
  confirmed — which is exactly the state 14 October left behind and could not
  report.
- `retryPendingRebuildEmails()` re-sends anything still marked, and is called at
  the end of `draftSocialPosts`. That run skips anything it already has a row
  for, so before this a vanished email was invisible forever. It is also
  runnable by hand, so the owner can recover in seconds rather than at 06:00.

**Why this design:** four of the five bugs in this feature produced a green
workflow and a wrong result. The fifth produced a green trigger and no output.
The pattern is silence, so the fix is to stop being silent — an outbox marker
and a retry, not a guess about why Gmail did what it did.

## The redraft looked for a post of type "undefined" (14 October 2026)

`runScheduledDraft_` reported:

```
The rebuild finished but no undefined was in the queue.
Details: Post types present: Weekly-141026, Weekend-161026
```

The rebuild marker records the post **type** so the rebuilt post can be found
again. `requestRegeneration_` read it from the Social row — but **after**
`clearDraftRow_` had deleted that row. The read returned an empty object, so the
type was recorded as undefined and the redraft eight minutes later searched for
a post of that type.

The comment above the line said *"Remembered BEFORE the row is cleared"*. The
code did not do what the comment said. Worth remembering as a class of bug: a
comment asserting an ordering is not a test of it.

Two changes:

- The read now happens before `clearDraftRow_`, and there is a test that would
  fail if it moves back — the mock sheet really empties when cleared, so reading
  after the delete genuinely returns nothing.
- The marker now stores the PostID as well as the type, and the redraft falls
  back to the variant name in it (`Weekly-141026` → `Weekly`). A blank PostType
  column can no longer strand the feature.

**The new failure email worked.** This is the first of these bugs to announce
itself instead of being silent, which is the whole reason it was added.

## Nothing ever re-drafted the rebuilt post (14 October 2026)

The most important of the five, and the reason swapping events appeared to do
nothing even when the rebuild worked perfectly.

Dispatching the rebuild is only half the operation. Once GitHub has committed the
new queue, **something has to draft that post and email it.** Nothing did. The
only thing that drafted posts was the daily `draftSocialPosts` trigger, which:

- runs **once in the morning** at `DRAFT_TRIGGER_HOUR`, so a lunchtime rebuild
  was not picked up until the next morning; and
- is gated by `draftTypesFor_`, so on any day other than Monday or Friday it logs
  "Not a drafting day" and sends nothing.

A swap can be made on any day of the week. So a Wednesday rebuild produced a
correct image and **no email, ever** — Friday would only ever email the Weekend
post.

Observed 14 October 2026. The rebuild succeeded, the choices were applied, the
image was correct with all five chosen events, and no second email arrived.

Fixed by `runScheduledDraft_`: the rebuild trigger schedules a follow-up two
minutes later which drafts and emails the rebuilt post, bypassing the day gate.
It works on the post **type**, not the PostID, because whether the rebuilt post
keeps its ID or gains a revision suffix depends on which version of
`apply-choices.js` is in the repository — and this must work either way.

The day gate is deliberately still bypassed. It exists to stop an out-of-season
Weekend post landing in a Tuesday inbox, which is real. This is the owner asking
for their own post back after changing it, and they are waiting by the inbox.

## The repository's apply-choices.js is older than the local one

**Verified 14 October 2026 by fetching the raw file from GitHub.** The committed
`apply-choices.js` has the missing-event guard but **no revision stamp**. The
local copy adds `dateLabel = ddmmyy-r<rev>` and `rebuilt = true`.

This is why the rebuilt post kept its PostID. It is also why the version pinned by
the tests (`apply-choices.test.js`) disagrees with what actually runs — the tests
cover the local file, not the deployed one.

**Unresolved: this folder has no git installed and is not a git checkout**, so
the local file cannot be pushed. The revision stamp is therefore currently absent
in production. It is belt-and-braces — `requestRegeneration_` deletes the old
draft row, and `runScheduledDraft_` finds the post by type — so the feature works
without it, but the repository should be brought up to date when possible.

## The fourth quiet bug: Google's five-minute cache on the choices sheet

Found 14 October 2026. Symptom: the owner's choices were saved, the rebuild ran
green, `queue.json` was regenerated — with **the old events**, and no second
email ever arrived. Nothing in the workflow log was wrong.

Cause: a published Google CSV is served with `Cache-Control: private,
max-age=300`. Apps Script wrote the choice and dispatched the rebuild about a
second apart, so the workflow read the sheet as it was *before* the owner
pressed Approve. A cache-busting parameter is rejected with HTTP 400 on published
URLs, so it cannot be worked around.

**Fixed on the Apps Script side**, not in the workflow: `requestRegeneration_`
now calls `scheduleRebuild_()` instead of `triggerSocialRebuild_()` directly, and
the rebuild fires six minutes later via a one-shot trigger. The sheet has always
settled by then, so no polling is needed and only an actual swap pays the wait.

Three deliberate choices in that fix:

- **The wait is in Apps Script, not the workflow.** Polling inside
  `apply-choices.js` was written first and works, but it cost a repository change
  the owner could not make (no git on that machine — it is not a git checkout).
- **Only one rebuild is ever outstanding.** `deletePendingRebuilds_` clears
  previous ones, so approving twice quickly gives one rebuild from the newest
  choice, not two from stale ones.
- **Failure is emailed.** `runScheduledRebuild_` sends "the event rebuild did not
  start" rather than only logging. Silence is how all four of these bugs
  announced themselves, so the fix for that is to stop being quiet.

**Lesson worth keeping:** all four produced a green workflow and a wrong result.
`apply-choices.test.js` now covers the sheet parser directly, including a replay
of the real row published on 14 October 2026.

## Scheduling: Monday and Friday, changed 13 October 2026

| Post | Runs / emailed | Cron (UTC) |
|---|---|---|
| Weekly Roundup | **Monday** morning | `17 3 * * 1` |
| Weekend Roundup | **Friday** morning (was Thursday) | `17 3 * * 5` |

### Why the owner got the Weekend email on a Tuesday

Diagnosed 13 October 2026. **Two independent causes**, and either alone would
have done it.

1. **The Apps Script draft trigger had no weekday gate.** `draftSocialPosts`
   ran **every day** at 06:xx and emailed *any* post in the queue file it had
   not already drafted. A post sitting in the queue was therefore picked up by
   whichever daily run came next — so a post built late on a Friday, or over a
   weekend, arrived on whatever day followed. That is exactly the Tuesday email.

2. **The queue file held both posts at once.** `workflow_dispatch` passes
   `--all`, so a manual run generates the Weekly **and** the Weekend post
   together. The deployed `queue.json` was generated at 13:31 UTC on Monday
   12 October — a manual run, not the 03:17 cron, because 13:31 is not a cron
   time — and contained both. The Monday 06:xx draft run had already happened
   before that push, so the first run to see the Weekend post was Tuesday's.

**Fixed by gating drafting on the day.** `DRAFT_DAYS` in `social.gs` maps
Monday → Weekly Roundup and Friday → Weekend Roundup. On any other day the run
logs "Not a drafting day" and sends nothing. The post type is also checked, so
a Monday run cannot email a Weekend post that happens to be in the queue.

`londonWeekday_()` reads the weekday **in London**, not UTC — the script runs on
UTC, and a 06:00 British winter morning is still the previous day in UTC terms
for part of the night.

Override with a `DRAFT_WEEKDAYS` script property, e.g. `"1,5"`. An unusable
value falls back to Monday/Friday rather than disabling drafting.

### ScheduledFor is now only a label

It used to decide when a post published. Since the 11:00 cutoff landed it does
not — approval decides whether a post waits or goes at once. `SLOTS` in
`build-captions.js` therefore records only which roundup a post is. **The days
in it must still agree** with `VARIANTS.runOn` and `DRAFT_DAYS`, or a post
built on a Friday is labelled as a Thursday post and arrives on the wrong day.

Eight tests cover the gating.

## Scheduling: previously confirmed

| Post | `runOn` | Cron (UTC) |
|---|---|---|
| Weekly Roundup | `1` Monday | `17 3 * * 1` |
| Weekend Roundup | `4` Thursday | `17 3 * * 4` |

A scheduled run cannot produce the wrong post. A **manual** run passes `--all`
and generates both, deliberately. Monday and Thursday share a background, since
both fall in one ISO week.

---

## The posting cutoff — added 12 October 2026

**The owner asked for approval not to publish on the spot.** The rule:

| Owner approves... | What happens |
|---|---|
| before 11:00 UK time | post waits, publishes itself at 11:00 |
| at or after 11:00 UK time | publishes immediately |
| never | nothing happens, post stays a draft |

This replaced "no publishing trigger by design". There is now a publishing
trigger again, and **it is required** — without it an approved post sits there
forever and nothing ever goes out.

### How it is built

- `cutoffHour_()` — the hour, overridable via the `SOCIAL_CUTOFF_HOUR` script
  property. A value that is not 0–23 falls back to 11 rather than being
  trusted; a typo there would otherwise post at 3am.
- `cutoffOn_(londonDate, reference)` — the cutoff instant for a London date.
  London's UTC offset is **measured**, not tabulated, so there is no
  daylight-saving table to keep in step.
- `approveAndSchedule_()` — called by the approval button. Before the cutoff it
  parks the post and records `POST_CUTOFF_<PostID>`; after it, publishes at once.
- `publishSocialPosts()` — now selects on `POST_CUTOFF_`, **not**
  `ScheduledFor`. Runs every 15 minutes rather than once at 11:00, because a
  single trigger that fails once silently loses that week's post.

### Two decisions worth knowing about

1. **Why not key off `ScheduledFor`.** It says which roundup a post belongs to.
   Keying off it would publish a post the instant its slot arrived even if the
   owner had only approved at 10:58 — exactly what the cutoff exists to prevent.
2. **Approving by hand in the sheet publishes on the next run.** A row with no
   `POST_CUTOFF_` property was typed in by hand, which is an unambiguous
   instruction and is not second-guessed by waiting until 11:00.

### Grace window

An approved post is abandoned 13 hours past its cutoff and marked Failed with a
note saying so, rather than publishing a roundup days out of date. Set the Status
back to Approved to retry.

### A bug this introduced, found by the tests

`approveAndSchedule_` originally asked a "next cutoff" helper whether the cutoff
had passed. That helper only ever returns a time in the future, so the answer was
always "not yet" and **an approval made after 11:00 would have waited until the
next day** instead of posting at once — the opposite of the rule. The helper is
now `cutoffOn_` and returns today's cutoff, which may already have passed.

---

## Approval flow as built

```
email → Post this now → password prompt → publish
```

**Nothing publishes on a GET.** This matters more than it looks: mail clients and
link scanners prefetch URLs before anyone opens the message. An earlier design
published on click, so a scanner could have consumed the single-use token and
published the post unread. The password prompt stops that.

- Link lasts **14 days**, not one hour. The email arrives at 06:30 and is not
  read until the owner is awake — a one-hour link expired before it was ever seen.
- Single-use per post; spent before publishing.
- Five wrong passwords retire a link. Four do not — retiring earlier would let
  anyone lock the owner out of their own link.
- 19 tests cover prefetch, replay, expiry and lockout.

---

## Files changed this session

| File | Change |
|---|---|
| `build-captions.js` | New header format, closing line, `#sessions` |
| `post-header.js` | **New.** Shared header logic |
| `select-social-events.js` | Rotation reconciliation, tie-break, King's Hall, `//` preserved |
| `generate-social-images.js` | Footer removed, subtitle, rotation, exports |
| `social.gs` | **New.** Social tab, email, password gate, publisher |
| `submissions.gs` | `doGet`/`doPost` routing for the social actions |
| `check-meta-setup.js` | Decides the Instagram route from the token's permissions |
| `analyse-backgrounds.js` | **New.** Contrast and pattern-detail report |
| `lock-backgrounds.js` | **New.** Bakes treatment in, orders the rotation |
| `.gitignore` | queue.json committed; originals and previews ignored |

Planning tools that never run in the workflow: `analyse-backgrounds.js`,
`lock-backgrounds.js`.

---

## Second session, 12 October 2026 - review and fixes

A full read of `social.gs` and the `doGet`/`doPost` routing. Four things were
wrong or missing. All local; nothing uploaded.

### The handover's test claim was false

The previous version of this document claimed "19 tests cover prefetch, replay,
expiry and lockout." **There was no test file in the project and no `test`
script in `package.json`.** Those four properties are the entire safety argument
for the system, and nothing verified them.

`social-approval.test.js` now exists — 26 tests, `npm test`. It loads the real
`social.gs` into a `node:vm` sandbox with the Apps Script globals stubbed, so it
cannot drift away from the code it covers. Coverage by property:

- **prefetch** — a GET renders the password form, claims no success, and writes
  nothing to the Status column.
- **replay** — the nonce is spent on use, a second POST is refused, and nothing
  publishes twice.
- **expiry** — an over-age nonce is refused *and* deleted; the TTL is 336 hours.
- **lockout** — four wrong passwords keep the link; the fifth kills it; a correct
  password still works after one wrong attempt.

### Fixes to `social.gs`

1. **`getProperty_` now trims.** Values are pasted into the Script Properties UI
   by hand and a trailing newline survives. It mattered for `WEB_APP_URL`, which
   is concatenated into URLs and into the form's `action` attribute.
2. **The "edit the captions" link worked.** It was `?social=row&postId=...` with
   **no token**, which `doGet` routes to `handleSocialApprove_`, which checks the
   token first — so the link every approval email offered for editing captions
   always landed on "This approval link is not valid". It now points at the
   Social tab in the spreadsheet, which is what the email always meant.
3. **Dead `row.ImageURL` branch removed** from `socialImageUrl_`. `ImageURL` is
   not in `SOCIAL_COLUMNS`, so `readSocial_` never populated it and the branch
   read as though the sheet could override the image path when it cannot.
4. **Email text corrected.** It still described the old design — "it is published
   separately at the time above" (approval now publishes immediately) and "set
   Status to Rejected" (`Rejected` is not in `SOCIAL_STATUSES` and the dropdown
   has `setAllowInvalid(false)`, so the owner could not actually do it).
5. **Success page says "Approval successful."** Dry run still says "Approved
   (dry run)", because it did not actually publish and must not imply otherwise.
6. **First statement of `handleSocialPost_` is a log line**, so the Executions
   log can settle whether a POST arrived.

### The connection error is still unexplained

Desktop browser confirmed, so the phone hypothesis is dead. See "Broken right
now" above — it is now instrumented rather than guessed at.

---

## Known-broken things to fix or ignore

- **`check-js.ps1 -SelfTest` is broken**, independently of this work. It needs a
  line matching `events.push(ev);` and that line does not exist in the file it was
  written for. A plain `check-js.ps1 -Path <file>` still works and is what has
  been used throughout.
- **`GRID_SAFE`** is a judgement call the owner may want revisited.
- **Backgrounds are committed but the workflow has not been re-run** since they
  were locked in — verify the deployed site is showing them before the next post.
- **Node is not on `PATH`.** It is at `C:\Program Files\nodejs\node.exe`. The
  npm scripts assume `node` resolves; use the full path until that is fixed.

---

## Next steps, in order

1. **Redeploy `social.gs` with the cutoff changes**, then run
   `createSocialTriggers` **once** — the 15-minute publishing trigger must exist
   or nothing will ever go out. `socialStatus` confirms the cutoff in force.
2. **Attempt the System User token.** If it fails too, offer the manual fallback
   rather than continuing to chase it.
3. **One real test post** once the token works, then leave `SOCIAL_DRY_RUN` =
   `false`.

The "refused to connect" problem is **not blocking anything**. The post publishes
server-side before the confirmation page is built, so a broken page does not stop
a post going out. Do not spend the Meta token chase on it.

`SOCIAL_DRY_RUN` does **not** need setting. Unset already means dry run.

Nothing here is uploaded. When it is ready, `social/backgrounds/` must be
committed along with the JavaScript — `.github/` still needs
`upload-dotfiles.ps1`. `social-approval.test.js` and the `test` script in
`package.json` need committing too.