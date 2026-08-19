# AutoGrab

AutoGrab is an event-driven assistant for reacting to university seat-availability notifications. The MVP listens to a personal Gmail inbox through IMAP IDLE, validates a notification, extracts an allowlisted SLN, and hands a registration job to a guarded worker.

The current MVP authenticates, listens, validates candidate email, records an
deduplicated durable registration job, and can dispatch a guarded live attempt
automatically when the single registration mode is explicitly set to `live`.

## Architecture

```text
Personal Gmail inbox
        |
        v
IMAP IDLE listener --> validator --> SLN parser --> job queue
                                                    |
                                                    v
                                   warm Chromium registration worker
                                                    |
                                                    v
                                              result alerts
```

## Setup and commands

AutoGrab requires Node.js 24 LTS. The repository includes `.nvmrc`, so an
`nvm` user can select it with `nvm install && nvm use`. Confirm that
`node --version` begins with `v24` before installing dependencies.

```bash
npm install
cp .env.example .env
npm run typecheck
npm test
npm run oauth:gmail
npm run probe:gmail
npm run browser:setup
npm run worker:dry-run
npm run job:resume -- <job-id>
npm run target:sln
npm start
```

`npm run oauth:gmail` opens Google's desktop authorization flow and stores only
the resulting refresh credential in a private file under
`~/Library/Application Support/AutoGrab/`. Tokens are never written to project
files or logs.

`npm run probe:gmail` performs a read-only feasibility check: it connects to
Gmail over TLS with XOAUTH2, confirms `IDLE`, selects `INBOX` read-only, and
disconnects without fetching message content.

During normal listening, each unseen UID is retrieved with one merged bounded
IMAP FETCH containing envelope metadata, timestamp, size, and at most 256 KiB
plus one sentinel byte of raw source. This removes the previous second FETCH
round trip. Non-candidate or oversized source is discarded in memory and is
never written to logs or the job database.

`./bin/autograb` runs the recoverable Gmail listener and registration
coordinator directly and is preferred for long-running use. On its first run it
establishes a cursor at the current end of `INBOX`; later runs reconcile only
newer UIDs. In live mode it also opens one warm Chromium context at startup and
keeps it alive until shutdown. Stop everything cleanly with `Ctrl-C`. `npm
start` runs the same process, but npm may return the prompt before forwarding
the application's final shutdown output.

`npm run browser:setup` opens the private Chromium profile independently for
dry-run preparation or troubleshooting. Live mode no longer depends on closing
and reopening this setup browser: `npm start` opens the warm browser directly.
AutoGrab never receives or stores the NetID password or MFA response.

`npm run worker:dry-run` opens that profile, atomically claims one queued
single-SLN job, revalidates its target and quarter, and fills the uniquely
labeled SLN input. It cannot add the section to the cart or update the schedule:
those buttons are disabled and click-captured, form submission is suppressed,
service workers are disabled, and non-read network requests are blocked. A
prepared dry-run job ends in `blocked` with the reason
`dry_run_submission_disabled`.
Bundled targets are blocked as `dry_run_bundle_requires_cart` because safely
representing a bundle requires the cart behavior that dry-run disables.

One setting controls registration behavior and defaults to `dry-run`:

```env
AUTOGRAB_REGISTRATION_MODE=dry-run
```

In `dry-run`, `npm start` only validates notifications and queues jobs; browser
testing remains an explicit `npm run worker:dry-run` action. In `live`, `npm
start` opens Chromium immediately. Complete UW sign-in manually in that window
if requested, then leave it open. The Gmail listener runs alongside that same
browser, and every automatic attempt reuses its already-authenticated page.
Attempts are serialized so only one browser worker runs at a time. Duplicate
notifications, succeeded jobs, uncertain jobs, and non-retryable blocked jobs
do not trigger another attempt. A fresh notification creates a new job after a
failed or cancelled attempt, or after a retryable block such as
`pre_submission_stopped`.

The terminal reports `Warm UW browser state { state: 'ready' }` when live work
can proceed. If the state becomes `login_required`, authenticate manually in
the browser that is already open. The job remains queued and is redispatched
automatically when the warm page returns to `ready`; do not close Chromium.

`job:resume` remains a fallback when AutoGrab itself has been stopped. The
command opens Chromium, waits up to five minutes for manual UW sign-in, and can
continue an exact queued job without waiting for another email:

```bash
npm run job:resume -- <job-id>
```

The command works only in `live` mode and only for an existing `queued` job
whose complete target is still allowlisted. It cannot replay `failed`,
`uncertain`, `blocked`, cancelled, or succeeded jobs. Restart `npm start` after
the resumed attempt to continue listening for email.

The target allowlist can be inspected or changed while AutoGrab is running,
without editing `.env` or restarting the listener:

```bash
# Show the active runtime target list
npm run target:sln

# Replace it with one SLN
npm run target:sln -- 14693

# Replace it with multiple SLNs
npm run target:sln -- 14693 12345
# Comma-separated input is also accepted
npm run target:sln -- 14693,12345

# Treat a lecture and quiz as one atomic registration target
npm run target:sln -- 13277+13280

# Mix a bundle with independent targets
npm run target:sln -- 13277+13280 14693

# Ordered alternatives sharing one lecture
npm run target:sln -- 13277+13278 13277+13279 13277+13280
```

Spaces or commas separate independent registration targets. A plus sign joins
SLNs that Register.UW must receive in the same schedule update. A notification
for any member of a bundle queues the complete bundle; a second notification
for another member is attached to that same job instead of creating another
submission.

Targets may share an SLN. A notification for a unique quiz resolves directly
to its bundle. If a notification matches multiple targets, such as a shared
lecture notification, the first target in the command is used as the priority.

The command replaces the complete active target list and persists it privately
at `~/Library/Application Support/AutoGrab/target-slns.json`. Once this file
exists, it overrides `AUTOGRAB_TARGET_SLNS` across restarts. The listener reads
it for every candidate message, and a live worker reads it again immediately
before Update Schedule. Removing a target therefore stops an in-progress
attempt if final submission has not begun. It cannot undo a submission that
already started; use the `LIVE_STOP` kill switch to stop all pending live work.

The automatic live worker revalidates the allowlisted target and quarter, adds
every missing target SLN to the cart, verifies each cart entry, rechecks
cancellation and the kill switch, and invokes Update Schedule exactly once. It
confirms success only when every target SLN appears in the registered schedule;
a timeout or interruption after submission is recorded as `uncertain` and is
never automatically retried.

Create the manual kill-switch file at any time before final submission:

```bash
touch "$HOME/Library/Application Support/AutoGrab/LIVE_STOP"
```

The live worker also treats `SIGINT` or `SIGTERM` as a stop request. If a stop
arrives after Update Schedule has begun, the result is conservatively marked
`uncertain`. Live outcomes produce sanitized terminal output and a local macOS
notification containing only course, target SLNs, state, and a stable failure
code.

Notify.UW candidates are parsed from bounded raw RFC 822 content. Acceptance
requires the exact sender and recipient, matching subject/body course text,
Gmail-authored aligned DKIM and DMARC passes, supporting SPF pass, a fresh
arrival timestamp, the exact UW Registration root link, one five-digit SLN,
and membership in the configured SLN allowlist.

Trusted notifications are stored in a local SQLite database under
`~/Library/Application Support/AutoGrab/`. Database constraints deduplicate
Gmail deliveries and Message-IDs, allow only one actionable job per
registration target, and record an immutable state-transition history. Worker
claims use a transaction and a lease. If a running worker disappears, the job
becomes `uncertain` and is not automatically retried.

## Next iteration target

- Investigate section substitution: when an availability notification arrives,
  replace an enrolled section with a preferred section of the same course.
  This is a high-risk operation because dropping the enrolled section before
  securing the replacement could leave the user enrolled in neither. The
  feature must preserve the existing enrollment unless Register.UW can perform
  and confirm the drop and add as one atomic schedule update. It must never use
  a drop-first workflow, and it requires explicit per-substitution
  authorization, preflight enrollment checks, and post-submission
  reconciliation before live implementation.

## Current limitations

This is a macOS-oriented prototype with a UW-specific registration adapter.
The computer must remain awake and connected while monitoring; use
`caffeinate -i npm start` to prevent idle system sleep.

Warm-browser readiness checks inspect the visible page and do not validate
the server-side login session. An expired login may therefore be discovered
only during an attempt. Cart isolation between attempts and automatic session
refresh remain future work. Permanent OAuth failures currently retry with
backoff and require manual reauthorization. External Google OAuth apps in
Testing may require reauthorization after seven days.

Email and job deduplication reduce repeated attempts; they do not guarantee
exactly-once enrollment across browser, network, and server failures. Review
`uncertain` outcomes manually before attempting the same target again.

## Safety boundaries

- No password storage; Gmail access uses OAuth 2.0 with securely stored refresh credentials.
- No CAPTCHA, MFA, queue, or rate-limit bypass.
- Only configured SLNs may create registration jobs; bundled SLNs are submitted
  together.
- Dry-run mode remains the default.
- `AUTOGRAB_REGISTRATION_MODE=live` authorizes automatic attempts for every newly queued allowlisted SLN and any queued job recovered at startup.
- The target quarter must exactly match `AUTOGRAB_TARGET_QUARTER` (for example, `au26`).
- An ambiguous registration result is never blindly retried.
- Raw email, OAuth credentials, passwords, cookies, and browser sessions are not stored in the job database.
