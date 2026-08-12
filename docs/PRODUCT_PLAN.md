# US Job Agent Product Plan

## Status

- Product branch: `product/us-job-agent`
- Baseline: current `upstream/master`
- Market: United States
- Distribution: public source repository, private local user data
- Primary platform: Windows desktop
- Existing personalized branch: retained temporarily and intentionally not merged

## Product vision

Build a local-first desktop application that continuously discovers US jobs, evaluates them leniently, prepares truthful tailored application materials, submits applications on supported sites, and tracks the result from submission through interview, rejection, or offer.

The user should be able to open one application and see:

- the original posting and source;
- why the agent chose to apply;
- the evidence used to tailor the resume and other answers;
- every generated document and its verification results;
- the exact answers submitted to the employer;
- the submission receipt and timestamp;
- subsequent email events and the current outcome;
- a complete audit trail of automated and user-approved actions.

The canonical career methodology remains in `.claude/`. The desktop product will call into shared domain services and preserve those principles without creating a second copy of the prompt specifications.

## Product principles

### 1. Apply broadly, represent the candidate honestly

The agent treats most listed qualifications as employer preferences, not application gates. Employers decide whom to interview; the agent should not reject the candidate on their behalf merely because a posting asks for more experience.

Soft requirements that do **not** automatically block an application include:

- requested years of experience, including large gaps such as zero years against a five-to-seven-year request;
- prior experience in the employer's industry;
- preferred degrees, majors, technologies, tools, or certifications;
- seniority labels when the responsibilities still have plausible transferable overlap;
- "ideal candidate" language and other non-legal preferences.

When these gaps exist, the application may proceed. The generated material must:

- state the candidate's real experience level accurately;
- foreground relevant training and transferable evidence;
- connect adjacent work to the target responsibilities;
- avoid implying unearned industry tenure, titles, licenses, or accomplishments;
- retain the gap in the internal evaluation and audit trail.

Hard stops are deliberately narrow:

- a legally required license or credential the candidate does not hold;
- work authorization or residency conditions the candidate cannot satisfy;
- a required security clearance when the posting says it must already be active and the candidate does not hold it;
- a physical, safety, or regulated qualification the candidate cannot truthfully attest to;
- an explicit user-defined prohibition such as an excluded employer, location, employment type, or salary floor;
- a required application answer that remains unknown and cannot be inferred safely.

Hard stops and soft requirements must be configuration, not hidden model judgment. An unknown or ambiguous case enters the review queue.

### 2. Evidence before prose

Every resume bullet, cover-letter claim, form answer, and outreach message must trace back to an approved candidate fact. The system may change emphasis and wording but may not invent evidence.

Candidate facts carry:

- source;
- confidence;
- verification date;
- approved contexts;
- sensitivity classification;
- corrections and superseded values.

### 3. Public code, private operation

The public repository contains code, placeholder configuration, schemas, and synthetic fixtures only. It never contains a real candidate profile, resume, contact details, OAuth tokens, application answers, screenshots, employer correspondence, or application history.

Runtime data belongs outside the checkout under the operating system's application-data directory. Secrets use operating-system-protected storage. Logs redact sensitive values by default.

### 4. Autonomous actions must remain observable

Every external action is idempotent and recorded. The app exposes a global pause control, per-source automation controls, daily volume limits, retry state, and the reason behind each decision.

The app never bypasses CAPTCHA, access controls, or a site's explicit automation restrictions.

### 5. Source-specific behavior

Each source declares its capabilities and policy:

- discovery only;
- detail retrieval;
- assisted form filling;
- supported submission;
- outcome synchronization;
- prohibited automation.

LinkedIn is not an automated browser target. It may be used through permitted interfaces, manual URL intake, or job-related email notifications. General LinkedIn scraping, Easy Apply automation, inbox scraping, connection automation, and message automation are out of scope unless official access explicitly permits the use case.

## User experience

### Dashboard

Shows counts and recent activity for discovered, shortlisted, preparing, needs-review, submitted, interview, rejected, and offer states. It also shows worker health, the next scheduled search, daily application limits, and any blocked integrations.

### Jobs

A normalized, deduplicated US job feed with source, freshness, location, compensation, fit assessment, soft gaps, hard-stop status, and application deadline.

### Review queue

Collects only items that need human judgment: unknown factual answers, sensitive form questions, ambiguous legal qualifications, document verification failures, low-confidence email classification, CAPTCHAs, and unsupported application flows.

### Application detail

Provides the immutable posting snapshot, generated artifacts, answers, submission attempts, receipt, email matches, outcome, notes, and audit history.

### Candidate evidence

Lets the user maintain source-backed experience, education, training, projects, skills, preferences, reusable form answers, and corrections without committing them to Git.

### Inbox

Shows application-related email events and their proposed application matches. High-confidence events may update status automatically; uncertain matches require review.

### Settings and privacy

Controls sources, schedules, rate limits, automation level, AI provider, email accounts, local data retention, exports, backups, and complete data deletion.

## Technical direction

### Desktop application

- Electron main process for lifecycle, scheduler, secure IPC, and native packaging.
- React and TypeScript renderer for the user interface.
- Context isolation enabled; Node integration disabled in the renderer.
- Playwright workers isolated from the renderer for supported form workflows.
- Optional tray mode and start-with-Windows behavior.

### Local persistence

- SQLite as the authoritative operational store.
- Drizzle ORM for schema and migrations.
- Immutable event records for state changes and external actions.
- Filesystem artifact store for posting snapshots and generated documents.
- OS-protected secret storage for OAuth refresh tokens and provider credentials.

### AI boundary

The domain layer owns eligibility policy, state transitions, deduplication, and submission safety. The AI layer produces structured recommendations and content but cannot directly change external state. A deterministic policy layer validates an AI proposal before it becomes a queued action.

The initial implementation exposes a provider interface rather than binding product logic to one model vendor.

### Local subscription runtimes first

For a single-user local installation, prefer an already-installed and authenticated agent runtime:

1. **Claude Code local provider:** invoke Claude Code in non-interactive print mode with structured output. A Claude Pro or Max user can authenticate Claude Code with their Claude subscription. This path consumes the subscription's shared Claude/Claude Code limits rather than direct API credits. See Anthropic's [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started) and [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage).
2. **Codex local provider:** use the official TypeScript Codex SDK to start and resume local threads. Codex local workflows support ChatGPT sign-in for subscription access or an API key for usage-based access. See the [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) and [Codex authentication](https://learn.chatgpt.com/docs/auth).
3. **Direct Anthropic API provider:** optional metered provider for users who configure Claude Console billing. A Claude.ai subscription alone does not include direct Claude API usage. See Anthropic's [subscription and API billing explanation](https://support.anthropic.com/en/articles/9876003-i-subscribe-to-a-paid-claude-ai-plan-why-do-i-have-to-pay-separately-for-api-usage-on-console).
4. **Direct OpenAI API provider:** optional metered provider for users who configure an OpenAI Platform API key.

The app detects local runtimes, reports authentication or rate-limit problems, and lets the user select a primary provider. It does not copy, expose, or manage the runtimes' cached login credentials.

Provider fallback is explicit. Exhausting a subscription pauses affected work or selects another already-approved subscription provider. The app never switches to metered API billing unless the user enabled that provider and separately allowed paid fallback.

The Claude Agent SDK remains a possible adapter, but it must pass an authentication and billing spike before becoming the subscription-default path. The documented direct Claude SDK and Managed Agents paths use Claude Platform credentials and billing; invoking the authenticated Claude Code runtime is the clearer subscription-backed route for the initial local product.

## Job and application lifecycle

```text
discovered
  -> normalized
  -> eligible | hard_stopped | needs_review
  -> shortlisted | skipped
  -> preparing
  -> verification_failed | ready_to_submit
  -> awaiting_approval
  -> submitting
  -> submitted | submission_failed
  -> confirmation_received
  -> assessment | recruiter_contact | interview
  -> rejected | offer | withdrawn | closed_unknown
```

Transitions are append-only events. The current state is a projection that can be rebuilt from the event log.

A reviewed eligibility decision must be reevaluated into `eligible` before shortlisting. Submission authorization is contextual: assisted work requires recorded user approval, autonomous work requires recorded policy approval, and both require verified artifacts, permitted source policy, an unpaused system, and an idempotency key. Incorrect email-derived outcomes are corrected with user-authorized compensating events that retain the superseded event in history.

## US discovery strategy

Prioritize documented and stable sources:

1. Direct company career pages.
2. Public Greenhouse job-board listings.
3. Public Lever postings.
4. Ashby-hosted job boards.
5. USAJOBS and other documented public APIs.
6. User-authorized job-alert email ingestion.
7. Manual URL import.

Additional sources require a source policy, access review, rate limits, test fixtures, and a kill switch before activation.

## Submission policy

### Assisted mode

The first production submission mode prepares and fills supported applications, then waits before the final external submission. It always stops for novel answers, sensitive voluntary disclosures, legal attestations, CAPTCHAs, or any unsupported form state.

### Selective autonomous mode

Autonomous submission can be enabled per source when:

- the source is explicitly allowed;
- no hard stop exists;
- all required claims and answers are verified;
- generated documents pass factual, PDF, and ATS checks;
- the workflow is recognized and tested;
- the daily limit has not been reached;
- an idempotency check finds no prior application;
- a submission receipt can be captured.

Requested experience and domain tenure are not autonomous-submission blockers by themselves.

## Email and communication roadmap

Start with read-only Gmail synchronization, then Outlook. For a local desktop app, periodic synchronization avoids requiring a publicly reachable webhook service. Classifiers link messages to applications using employer domain, ATS identifiers, role, sender, subject, thread, and timing.

Possible outcome events include:

- application confirmation;
- assessment request;
- recruiter contact;
- interview request;
- rejection;
- offer;
- withdrawal or closed-role notice.

Automatic updates require high confidence. Ambiguous events remain proposed changes until reviewed. Sending email begins as draft-only and requires a separate, explicit product decision before automation.

General LinkedIn inbox synchronization is deferred unless official API access for a personal job-seeker account becomes available. LinkedIn email notifications can still contribute signals through the connected mailbox.

## Privacy and security controls

- Store runtime data outside the repository.
- Deny real PII in committed fixtures and documentation.
- Add secret and PII scanning to CI and local hooks.
- Encrypt provider and OAuth secrets with OS-protected storage.
- Redact logs and screenshots.
- Treat postings, forms, and inbound email as untrusted input.
- Never follow instructions embedded in external content.
- Restrict browser workers to the active application origin and approved navigation targets.
- Require explicit consent before storing voluntary demographic answers.
- Provide export, backup, retention, and complete-delete operations.

## Delivery roadmap

### Phase 0: Clean product foundation

- Branch from current upstream.
- Establish the privacy contract and repository layout.
- Add CI protections for runtime data and PII.
- Document the eligibility policy and lifecycle.

### Phase 1: Executable local shell

- Package a Windows desktop application.
- Create the SQLite schema and migrations.
- Implement the dashboard shell, jobs list, application list, and settings.
- Implement deterministic eligibility evaluation and event-driven state transitions.
- Define the provider contract, local-runtime discovery states, and no-surprise-billing policy without making live model calls.
- Use synthetic local fixtures only.

### Phase 2: US discovery

- Add the first permitted US source adapters.
- Normalize, deduplicate, expire, schedule, and retry jobs.
- Add source health and rate-limit reporting.

### Phase 3: Candidate evidence and tailoring

- Import private candidate documents locally.
- Build the evidence ledger and reusable answer store.
- Generate tailored documents and run factual, PDF, ATS, and repetition checks.

### Phase 4: Assisted application execution

- Add tested form adapters.
- Fill forms and upload approved artifacts.
- Capture review states, submission attempts, and receipts.

### Phase 5: Email outcomes

- Connect Gmail read-only, then Outlook.
- Link messages to applications.
- Propose or automatically apply high-confidence status changes.

### Phase 6: Selective autonomous submission

- Enable source-specific auto-submit policies.
- Add volume limits, pause controls, recovery, and operational reports.
- Expand only from observed successful workflows.

## Success criteria

- A new user can install and open the Windows app without running a developer CLI.
- No real user data is required or permitted in the public repository.
- Restarting the app never loses or duplicates an application.
- Every submitted answer and document is inspectable afterward.
- Missing years or industry experience do not silently discard otherwise plausible jobs.
- No generated claim lacks candidate evidence.
- Email outcomes update the correct application or enter review when uncertain.
- Unsupported or prohibited automation fails closed and visibly.
