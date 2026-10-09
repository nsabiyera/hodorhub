# HodorHub — Product Backlog

> **Vision:** HodorHub connects charity organisations with corporations through the amplifying power of social media. Charities post and promote projects; public support signals demand; corporations discover high-interest projects and deliver them by donating employees' skilled time (training/CSR hours) — for example, a developer donating 2 hours a week, or a team running a delivery sprint.

## Personas

| # | Persona | Description | Primary goal |
|---|---------|-------------|--------------|
| P1 | **Charity Owner** (Petra) | Staff/volunteer at a registered charity who creates and manages projects. | Get a project noticed and delivered. |
| P2 | **CSR Manager** (Carlos) | Corporate lead responsible for social/corporate responsibility programmes and volunteering budgets. | Find impactful projects that fit their people's skills and CSR goals. |
| P3 | **Corporate Volunteer** (Dev Dana) | An employee (e.g. software developer) who donates skilled time via their employer. | Contribute skills to meaningful work within their allocated hours. |
| P4 | **Supporter** (Sam) | A member of the public on social media who likes/shares/supports projects. | Back causes they care about and see them succeed. |
| P5 | **Platform Admin** (Alex) | HodorHub operator who verifies organisations and moderates content. | Keep the platform trustworthy and safe. |

## Story format & conventions

Each story follows: **As a** \<persona\>, **I want** \<capability\> **so that** \<value\>, with acceptance criteria in Given/When/Then form. Priority uses **MoSCoW** (Must / Should / Could / Won't-yet). Stories are grouped into **Epics**.

---

## Epic 1 — Accounts, Onboarding & Verification

### US-1.1 Charity registration — *Must*
**As a** Charity Owner, **I want** to register my organisation with charity-registration details **so that** supporters and corporations trust that my projects are legitimate.
- **Given** I am a new user, **when** I sign up as a charity and submit my charity/registration number, contact and organisation details, **then** my account is created in a *pending verification* state.
- **Given** my details are submitted, **when** verification is incomplete, **then** I can save drafts but cannot publish a project publicly.

### US-1.2 Corporation registration — *Must*
**As a** CSR Manager, **I want** to register my company **so that** I can express interest in projects and manage our volunteering commitments.
- **Given** I sign up as a corporation, **when** I provide company details and a verified work email domain, **then** an organisation workspace is created that colleagues can be invited to.

### US-1.3 Organisation verification — *Must*
**As a** Platform Admin, **I want** to review and approve/reject organisation applications **so that** only legitimate charities and corporations operate on the platform.
- **Given** a pending organisation, **when** I approve it, **then** it gains a verified badge and full platform access; **when** I reject it, **then** the applicant is notified with a reason.

### US-1.4 Team member invitations — *Should*
**As a** CSR Manager, **I want** to invite colleagues (managers and volunteers) into our workspace with roles **so that** the right people can pledge and deliver work.
- **Given** I am an org admin, **when** I invite a colleague by email and assign a role (Admin / Manager / Volunteer), **then** they receive an invite and, on acceptance, inherit that role's permissions.

### US-1.5 Employee (volunteer) onboarding — *Should*
**As a** Corporate Volunteer, **I want** to join my employer's workspace and set my skills and available donated hours **so that** I get matched to suitable tasks.
- **Given** an accepted invite, **when** I complete my profile with skills, seniority and weekly available hours, **then** my availability is visible to my CSR Manager for allocation.
- **Given** I am **any** signed-in user (not only a volunteer), **when** I set a **display name**, **then** it replaces my email address wherever a person is named to another human: the message author label (US-8.3 `authorLabel`) and the volunteer labels my own colleagues read on the delivery board (US-6.3). My email remains my login and my organisation admin still sees it in the member list — that is the key they invited me by and the only way to re-invite or contact me — but it stops being how strangers and counterparties are shown who I am.
- **Given** I have never set a display name, **when** any of those surfaces render, **then** they fall back to my email exactly as today: no user needs a name row to exist and no backfill is ever required (same rule as US-8.2 preferences).
- **Given** a user who has been **erased** (GDPR), **when** their name is rendered on a surface that outlives them — a message thread, whose rows are redacted rather than deleted — **then** it reads *Former member*, never the `erased-…@erased.invalid` placeholder that Privacy writes into `users.email`.
- **Given** I belong to **more than one** organisation, **when** I set skills, seniority and weekly available hours, **then** they belong to that **membership**, not to me as a person: each employer sees only the profile I filled in for them, nothing is copied between them, and no organisation can learn that I hold a membership anywhere else. Donated hours are the *employer's* hours to donate, so "4 hours a week" is only ever a statement about one employer's week. My **display name** is the exception and is person-level — one human, one name.
- **Given** my membership is removed and the seat released (US-10.7), **when** that happens, **then** that organisation's copy of my profile goes with it, while my display name — mine, not theirs — survives.
- **Given** I open my profile, **when** I save it, **then** **at least one skill and a weekly available-hours figure are required**; **seniority is optional**, because a volunteer may genuinely not sit on a ladder (contractor, exec, non-technical) and a forced choice manufactures junk data that US-4.3 would later match on.
- **Given** I state **0** hours a week, **when** my CSR Manager reads the roster, **then** it shows that I have offered none — which is **distinct** from *no stated availability* for someone with no profile at all. Unknown is never rendered or counted as 0, the same discipline as pending-vs-approved hours (US-6.2a): the platform never turns "nobody said" into a number.
- **Given** I have accepted an invite and completed nothing, **when** I sign in, **then** I can do everything my role already allows — open the board, be allocated (US-6.1), log hours (US-6.2), read what my role may read. The profile is a **dismissible prompt** on first sign-in, never a gate: an unfilled form must not be able to strand an invited employee or block their manager's delivery plan.
- **Given** a volunteer's skills, seniority and availability, **when** they are read, **then** only that volunteer and the **csr_manager / charity_owner** of the *same* organisation may read them — precisely the people who can actually allocate (US-6.1) and invite (US-1.4). Colleagues on the same roster may **not**: no story needs one volunteer browsing another's week, and an internal surveillance surface is easy to open and hard to close.
- **Given** the delivering charity, **when** they open the shared board (US-6.3) or the progress read (US-6.4), **then** they still see `Volunteer 1..n` and the **aggregate** allocated weekly capacity, and **no** skill, seniority, availability, display name or over-allocation for any employee. US-6.3's roster-withholding position is deliberately unchanged: what a corporation owes a charity about its people is the pledge (US-5.2) and the capacity actually allocated, not its employees' CVs. Nothing here is ever public, and a platform admin gets **404**, not 403.
- **Given** I have stated N hours a week, **when** my CSR Manager allocates me so that my total across **that employer's** workspaces on projects that are not *completed* or *archived* would exceed N, **then** the allocation **succeeds**, is flagged as **over-allocated** in the allocation's own response and on the roster afterwards, and I am notified (*donated hours* kind, honouring US-8.2). The over-allocated total is derived at read time, never stored, and is never shown to the charity.
- **Given** I pick my skills, **when** I choose them, **then** they come from **one controlled registry held in code** — the shape of US-11.12's template registry and US-2.6's category taxonomy — in which **each skill declares the existing project `category` it belongs to**, so US-4.3 matches on the taxonomy we already have instead of inventing a second axis. Free text is permitted only as a short human-readable note beside the chosen skills; it is displayed and **never** matched on. A skill outside the registry is rejected with a field-level error.
- **Given** any of this data, **when** discovery, ranking or the support score is computed, **then** none of it participates. Seniority in particular ranks nobody, gates no allocation and unlocks no task — it is descriptive only.
- **Given** right-to-erasure, **when** a user is erased, **then** their display name and **every** membership profile they hold are **deleted**, not redacted. Unlike a US-8.3 message — one half of a two-party record another organisation depends on — a skills profile is one-sided and nobody else's record needs it. Privacy's hand-written sweep must name the new tables, so a user with two organisations loses both profiles in one erasure.
- **Given** I want that data gone without leaving my employer, **when** I delete my profile, **then** I return to *no stated availability* and my allocations, logged hours and approved hours are untouched — those are the employer's and the charity's record and already survive erasure.
- **Given** seat counting (US-10.7), **when** profiles are introduced, **then** nothing about seats changes: a seat is a membership, filled in or not.
- *Scope — what this defers to **US-4.3**:* this slice **stores and shows** skills and availability; it **matches nothing**. No recommendations, no ranking of people, no auto-assignment, no "projects that suit me" feed. US-4.3 gains one hard prerequisite from this story: `resource_needs.skill` is still free text and must be converted to the same registry before any match is credible. That is a charity-facing change to US-2.2 (validation, backfill, publish gate) and is deliberately **not** done here — one registry exists from this story onward, with the charity side a known unconverted consumer, not a competing second list.
- *Out of scope:* calendars, date-ranged availability, holidays or per-day hours (one number per week; a calendar is a different product) · CV upload, certifications, endorsements or ratings (HodorHub rates projects, not employees) · avatars/photos (more PII, no value in this loop) · a full DSAR export (none exists today) · fixing US-1.4's invited-user password-reset deferral · charity-side staff profiles (technically the same shape, but no charity story asks for one, so nothing is surfaced) · a multi-organisation switcher (see *Known limit*).
- **Product decisions (2026-09-04):** **A display name is in scope**, though the narrative AC never mentions one — not as polish but as **data minimisation**. Two shipped surfaces currently push an employee's work email across an organisation boundary (`authorLabel` to the counterparty charity; the board to colleagues), and US-8.3 shipped a comment naming this story as the seam. "Dana Okafor" is *less* personal data than `dana.okafor@acme.com`, so the cheap version — one optional person-level field plus the existing email fallback — is a net privacy improvement, and leaving it out would mean knowingly shipping a third surface (the roster) that names people by email. It changes **nothing** for the charity's view of the board: only people who *chose to speak* are named (US-8.3's stated divergence), and volunteers cannot post at all. **The profile is the membership's, not the person's**, because availability is a claim about one employer's donated week and copying it between tenants would be a leak nobody consented to. **Over-allocation warns, it never refuses**: the employer authorises the donation (the same authority direction as US-6.2a approval), and a hard cap would bind only the people honest enough to fill the form in — rewarding the ones who did not. The call is the **CSR Manager's**, on the record, with the volunteer told. **The profile is never a gate on anything**, because a story about onboarding must not be able to strand the person it onboards.
- **Clarifications (2026-09-04, from the design):** the over-allocation sum is **same-employer only** — a global sum would compare one employer's stated hours against a total inflated by another's, warning about a constraint they cannot see, and would leak the existence of a second membership through the arithmetic. And "flagged at the point of decision" ships as **data on the allocation response**, not a rendered banner: US-6.1 is API-only and this story does not build an allocation form.
- **Known limit:** `identity.getUserOrg` resolves a user's **first** membership arbitrarily (documented in the US-8.3 design). The data model here is correct per membership, but until that is fixed the UI can only reach the profile of whichever membership the app happens to resolve, so a genuinely multi-organisation user cannot edit their second profile. They are not blocked from working; they are blocked from *stating availability* to the second employer. Accepted for this slice; the fix belongs with a proper organisation switcher, not here.
- ✅ **Delivered 2026-09-05.** `users.display_name` + `membership_profiles` (keyed on the membership, cascading with the seat) + `membership_profile_skills`; a 39-entry code-held skills registry in `identity/skills.ts`, each skill mapped to existing `project_category` values; six seniority levels with **no ordinal field**. `personLabel` is Identity's one definition of how a person is named and now feeds US-8.3's `authorLabel` and US-6.3's board — an erased user reads *Former member*, never the `erased-…@erased.invalid` placeholder. Delivery owns the over-allocation sum (`getVolunteerLoad`), same-employer and live-projects only, warning via a *donated hours* notification to the volunteer alone. Reporting composes the roster. **Fixed a latent defect found in refinement:** `allocations` had no unique `(workspace, volunteer)`, so a volunteer could be allocated twice and double-count — migration `0019` dedupes (largest hours survives; hour logs and board tasks repointed first) and `allocateVolunteer` is now an upsert. Routes: `GET/PUT/DELETE /api/profile`, `PUT /api/display-name`, `GET /api/skills`, `GET /api/organisations/[id]/roster`; pages `/profile` and `/team`. Design: `docs/superpowers/specs/2026-09-04-volunteer-profile-design.md`.
- *Sequencing:* this should be taken **early** in Release 2, not late. Its dependencies (US-1.4 invitations, US-6.1 allocation, US-6.3 board, US-8.3 messaging) are all shipped, and two of them are showing employees' email addresses to other people today.

---

## Epic 2 — Charity Project Creation & Management

### US-2.1 Create a project — *Must*
**As a** Charity Owner, **I want** to create a project with a title, description, goals, required skills and estimated effort **so that** supporters and corporations understand what help I need.
- **Given** I am verified, **when** I fill in the project form and publish, **then** the project appears publicly with a shareable page.
- **Given** required fields are missing, **when** I try to publish, **then** I am blocked with clear field-level validation.

### US-2.2 Specify needed resources — *Must*
**As a** Charity Owner, **I want** to describe the resources a project needs (skills, roles, hours, or a delivery sprint) **so that** corporations can gauge whether their people fit.
- **Given** I am editing a project, **when** I add resource needs (e.g. "1 backend developer, ~2 hrs/week for 8 weeks" or "one 2-week sprint"), **then** they display as structured, filterable requirements.

### US-2.3 Rich project media — *Should*
**As a** Charity Owner, **I want** to add images, a short video and impact story **so that** my project is compelling and shareable.

### US-2.4 Manage project lifecycle — *Must*
**As a** Charity Owner, **I want** to move a project through states (Draft → Published → In Delivery → Completed → Archived) **so that** everyone sees its current status.
- **Given** a corporation has committed, **when** delivery begins, **then** the project shows *In Delivery* and stops accepting new corporate interest unless I re-open it.

### US-2.5 Edit and close projects — *Should*
**As a** Charity Owner, **I want** to edit or close a project and notify supporters **so that** engagement reflects the current reality.

### US-2.6 Categorise a project — *Should*
**As a** Charity Owner, **I want** to give my project a category (e.g. Software, Design, Construction, Marketing, Fundraising, Events, Research/Data, Legal, Operations) **so that** corporations can find work that matches their people's skills.
- **Given** I am creating or editing a project, **when** I choose a category from the defined taxonomy, **then** it is saved and shown on the project (list + detail).
- **Given** I try to publish, **when** no category is set, **then** publish is blocked (category is required to publish, alongside title/description/goal/≥1 resource need) so discovery stays usefully filterable.
- **Given** a category outside the taxonomy is submitted, **when** validated, **then** it is rejected with a field-level error.
- **Given** the Discovery feed (extends US-4.1), **when** a corporation filters by one or more categories, **then** only projects in those categories are returned, still ranked by support (US-4.2) — category never affects ranking, only the filter.
- **Notes:** the taxonomy is a controlled, admin-extensible list (start with the set above; a `pgEnum`/lookup + a `projects.category` column). Category also feeds skill-based recommendations later (US-4.3). Merit-integrity holds: filtering ≠ ranking.

### US-2.7 Declare a digital-resource need — *Must*
**As a** Charity Owner, **I want** to declare that a project needs a digital resource **so that** corporations can fulfil the substrate my project runs on, not only the labour.
- **Given** I am editing a project, **when** I add a resource need, **then** I can choose kind = *digital resource*, pick a type from a controlled list, with optional free-text detail and optional quantity + unit (e.g. "GitHub Team, 5 seats"; "AWS credits, ~$500").
- **Given** a digital-resource need, **when** it displays, **then** it appears in the project's structured resource-needs list alongside skill/role/hours needs.
- **Given** I enter a quantity, **when** saved, **then** it is stored as a plain number + unit string — no monetary valuation is computed or required.

---

## Epic 3 — Social Media Promotion & Public Engagement

### US-3.1 Shareable project pages — *Must*
**As a** Charity Owner, **I want** every project to have a public page with rich social preview cards (Open Graph / Twitter Card) **so that** links shared on Facebook and Twitter look attractive.
- **Given** a published project, **when** its URL is shared on Facebook/Twitter, **then** the preview shows the title, image and summary.

### US-3.2 One-click social sharing — *Must*
**As a** Supporter, **I want** to share a project to Facebook or Twitter in one click **so that** I can rally my network.

### US-3.3 Like / support a project — *Must*
**As a** Supporter, **I want** to like and "support" a project **so that** my backing counts toward its visibility.
- **Given** I am signed in (or via lightweight social auth), **when** I like a project, **then** its support count increments and I can undo it.

### US-3.4 Connect social accounts — *Must*
**As a** Charity Owner, **I want** to connect my organisation's Facebook and Twitter/X accounts (and link the project's promoting posts) **so that** real engagement on those posts can be counted.
- **Given** I am editing a project, **when** I authenticate a social account and attach a post/campaign URL, **then** HodorHub stores the connection and begins tracking that post's engagement.

### US-3.5 Aggregate real social signals — *Must*
**As a** Charity Owner, **I want** on-platform likes plus **real** engagement (shares, likes, reactions) ingested from the connected Facebook/Twitter posts aggregated into a single **support score** **so that** momentum reflects genuine public backing.
- **Given** connected social accounts and attached posts, **when** engagement occurs off-platform, **then** counts are ingested via the social platforms' APIs/webhooks (respecting their terms and rate limits) and reflected in the support score within a defined refresh window.
- **Given** an API/rate-limit failure, **when** ingestion cannot complete, **then** the last known counts are shown with a "last updated" timestamp rather than resetting to zero.

### US-3.6 Trending & leaderboards — *Should*
**As a** Supporter, **I want** to see trending and most-supported projects **so that** I can discover causes gaining momentum.

### US-3.7 Social login — *Should*
**As a** Supporter, **I want** to sign in with Facebook or Twitter **so that** I can support projects without creating another password.

### US-3.8 Milestone celebration posts — *Could*
**As a** Charity Owner, **I want** the platform to auto-suggest a celebratory social post when a project hits a support milestone **so that** momentum keeps building.

---

## Epic 4 — Discovery & Matching (Corporation side)

### US-4.1 Browse & filter projects — *Must*
**As a** CSR Manager, **I want** to browse projects filtered by **category** (US-2.6), cause, required skills, location, time commitment and support score **so that** I find opportunities that fit our people.

### US-4.2 Popularity-driven discovery — *Must*
**As a** CSR Manager, **I want** projects ranked by public support **so that** I can back causes my customers and community already care about.
- **Given** a project list, **when** I sort by support score, **then** the most-supported projects surface first.

### US-4.3 Skill-based recommendations — *Should*
**As a** CSR Manager, **I want** recommendations that match our employees' skills and available donated hours to project needs **so that** I spend less time searching.
- *Prerequisite (from US-1.5):* the employee side of the match comes from US-1.5's **single skills registry** (each skill mapped to a US-2.6 project category). The charity side, `resource_needs.skill`, is still **free text** and must be converted to that same registry before any match here is credible — matching two uncontrolled vocabularies is not a recommendation, it is a guess. That conversion is US-4.3's work, not US-1.5's.

### US-4.4 Watch / shortlist projects — *Should*
**As a** CSR Manager, **I want** to shortlist and get alerts when a watched project trends **so that** I can act at the right moment.

---

## Epic 5 — Corporate Interest & Commitment

### US-5.1 Express interest — *Must*
**As a** CSR Manager, **I want** to express interest in a project **so that** the charity knows we may deliver it.
- **Given** a published project, **when** I express interest, **then** the charity is notified and the interest appears on the project (visible to the charity, optionally public).

### US-5.2 Pledge donated time — *Must*
**As a** CSR Manager, **I want** to pledge specific donated resources (e.g. "2 developers × 2 hrs/week for 6 weeks" or "a 1-week team sprint") **so that** the charity understands the concrete commitment.
- **Given** interest is expressed, **when** I submit a pledge, **then** it is recorded with resource type, quantity, cadence and duration, and awaits charity acceptance.

### US-5.3 Charity accepts/declines a pledge — *Must*
**As a** Charity Owner, **I want** to review and accept or decline corporate pledges **so that** I control who delivers my project.
- **Given** a pledge, **when** I accept it, **then** the project moves toward *In Delivery* and a delivery workspace is created for both parties; **when** I decline, **then** the corporation is notified with an optional reason.

### US-5.4 Multiple corporations on one project — *Could*
**As a** Charity Owner, **I want** to accept complementary pledges from more than one corporation **so that** larger projects can be co-delivered.

### US-5.5 Offer an in-kind resource gift — *Must*
**As a** CSR Manager, **I want** to offer to fulfil a digital-resource need **so that** the charity knows a concrete gift is on the table.
- **Given** a published project with a digital-resource need, **when** I submit a resource-gift offer (kind, quantity/detail, optional note), **then** it is recorded with status `offered` and awaits charity acceptance.
- **Given** my offer, **when** the charity reviews it, **then** they can accept or decline it exactly as any pledge (US-5.3), with an optional reason on decline.
- **Given** acceptance, **when** it happens, **then** it is recorded as a coordinated commitment; HodorHub transfers and provisions nothing, and no delivery workspace is created.
- **Given** I am not a CSR Manager of a verified corporation, **when** I attempt to offer, **then** it is refused (verified-actor gate, US-1.3).

---

## Epic 6 — Volunteer Time & Delivery Management

### US-6.1 Allocate employees to a commitment — *Must*
**As a** CSR Manager, **I want** to assign specific employees to an accepted pledge with their donated hours **so that** capacity is planned.
- **Given** an accepted pledge, **when** I assign volunteers with weekly hours, **then** the total allocated capacity is shown against the pledge.

### US-6.2 Log donated hours — *Must*
**As a** Corporate Volunteer, **I want** to log the hours I contribute against a project **so that** my donated time is tracked accurately.
- **Given** I am assigned, **when** I log hours with a note, **then** the entry is recorded in a *pending approval* state and does not yet count toward reported totals.

### US-6.2a Employer approval of hours — *Must*
**As a** CSR Manager, **I want** to review and approve (or reject) hours logged by my employees **so that** our CSR reporting reflects only verified contributions.
- **Given** pending logged hours, **when** I approve an entry, **then** it counts toward the volunteer's, the company's and the charity's totals; **when** I reject it, **then** the volunteer is notified with a reason and can amend and resubmit.
- **Given** a project view, **when** anyone reads contribution totals, **then** approved and pending hours are shown distinctly so nothing appears verified before it is.

### US-6.3 Delivery workspace & tasks — *Should*
**As a** Charity Owner and Corporate Volunteer, **I want** a shared workspace with tasks, milestones and messaging **so that** we collaborate on delivery in one place.
- **Given** an accepted pledge (US-5.3) and therefore a delivery workspace, **when** the charity owner or any member of the delivering corporation opens it, **then** both see the *same* shared board — the project's goal, its milestones and the tasks beneath them; **when** anyone outside those two organisations asks for it, **then** it is a **404**, not a 403 (no existence leak).
- **Given** the workspace, **when** the charity owner or the CSR manager adds a task, **then** it is created *to do*, optionally under a milestone, and assignable only to a volunteer already allocated to *this* workspace (US-6.1) — never to someone outside it.
- **Given** a task assigned to me, **when** I move it to *in progress* or *done*, **then** the change is recorded; **given** a task that is unassigned or another volunteer's, **when** I try to move it, **then** only the charity owner or the CSR manager may.
- **Given** the workspace, **when** the **charity owner** creates a milestone (title, optional due date), **then** it is *open* — and only the charity owner may create one or mark one *achieved*. The delivering corporation never confirms its own delivery (mirrors approved-vs-pending hours, US-6.2a, and provided-vs-received gifts, US-6.5).
- **Given** every task under an open milestone is *done*, **when** anyone reads the workspace, **then** that milestone reads *awaiting the charity's confirmation* — completed work is never silently promoted to achieved.
- *Scope:* the **messaging** named in this story is delivered by **US-8.3** (in-context messaging), which is the same conversation surface for the project and this workspace. Tasks, milestones and progress land here.

### US-6.4 Track progress against goals — *Should*
**As a** Charity Owner, **I want** to see delivery progress against the project's goals and milestones **so that** I know if it's on track.
- **Given** a project in delivery, **when** the charity owner reads progress, **then** it is shown *against the stated goal* (US-2.1): the goal itself, then each milestone with its due date, status and task counts, then the tasks tied to no milestone.
- **Given** an open milestone whose due date has passed, **when** progress is read, **then** it is flagged **overdue**.
- **Given** logged effort, **when** progress shows it, **then** allocated weekly capacity, **approved** hours and **pending** hours are three separate figures and are never summed into one (US-6.2a).
- **Given** a project with no delivery workspace yet, **when** progress is read, **then** it says there is nothing in delivery rather than showing a misleading empty board at 0%.
- *Scope:* agent-delivered work is **not** merged into these figures — it has its own run panel (Epic 11) and its own impact line (US-7.2), for the same merit-integrity reason as US-11.9.
- ✅ **Delivered (2026-09-03).** `delivery_milestones` + `delivery_tasks` on the existing workspace; `GET /api/workspaces/[id]` (shared board), `POST .../tasks`, `PATCH /api/tasks/[id]`, `POST .../milestones`, `POST /api/milestones/[id]/achieve`, `GET /api/projects/[id]/progress`, and a `/workspaces/[id]` page. Two rules are structural, not procedural: **only the charity creates and confirms a milestone** (so "every task is done" is derived as `readyToConfirm`, never stored — the same shape as US-6.2a and US-6.5), and a task's assignee is an `allocations` **row reference**, which makes "allocated to this workspace" true by construction. Outsiders and platform admins get 404, not 403. Messaging stays with US-8.3. Design + live-verification outcome: `docs/superpowers/specs/2026-09-03-delivery-workspace-design.md`.

### US-6.5 Confirm a gift was provided / received — *Should*
**As a** Charity Owner, **I want** to confirm when a pledged resource was actually provided **so that** "promised" is never shown as "delivered".
- **Given** an accepted resource gift, **when** the corporation marks it *provided*, **then** it shows as *provided (pending confirmation)*.
- **Given** a provided gift, **when** I confirm receipt, **then** it becomes *received*; provided vs received are always shown distinctly (mirrors pending/approved hours, US-6.2a).
- *Should, not Must:* the slice is demoable at accept (US-5.5). Confirmation is the honest completion of the loop and cheap given the hour-log pattern, but is the cut line if the slice must shrink.

---

## Epic 7 — Impact, Reporting & Recognition

### US-7.1 Corporate CSR dashboard — *Should*
**As a** CSR Manager, **I want** a dashboard of total donated hours, projects supported and outcomes **so that** I can report our social impact internally and externally.

*Acceptance criteria (drafted and agreed 2026-09-01):*
- **Given** my corporation, **when** I open the dashboard, **then** I see totals across every project we supported: approved donated hours, projects supported, and their outcomes.
- **Given** hours our volunteers logged, **when** totals are computed, **then** only **approved** hours count toward the headline; pending hours are shown separately and never added to it (US-6.2a).
- **Given** resource gifts we offered, **when** the dashboard reports what we gave, **then** only **received** gifts count as delivered; offered/accepted/provided are shown distinctly (US-6.5).
- **Given** another corporation's projects and hours, **when** my dashboard is computed, **then** they are never included — every figure is scoped to my organisation.
- **Given** projects we funded for agent delivery, **when** the dashboard reports impact, **then** compute spend and agent-delivered projects appear in **their own section, in their own units** (currency and runs) and are never summed with donated hours — agent delivery is reported separately, not as a substitute for it (Epic 11, US-11.9).
- **Given** a completed project we supported, **when** I view the dashboard, **then** its outcome story is shown or linked, so I can quote it in internal reporting (US-7.3).
- **Given** I am not a CSR manager of that organisation, **when** I request the dashboard, **then** it is refused.
- ✅ **Resolved (2026-09-01).** `getCorporateImpact` in the Reporting context, `GET /api/organisations/[id]/impact`, and a `/dashboard` page (CSR managers only; everyone else is redirected). Donated time and agent delivery are **two sections in two unit systems** — approved hours and volunteers on one side, runs and £ spent on the other — so compute money can never read as an hours-equivalent. Approved/pending hours and received/promised gifts stay split, as in US-7.2. Org scoping is enforced by every underlying read re-checking CSR membership and filtering on `corporationOrgId`; a regression test delivers a rival corporation's 40 hours on the same charity and asserts the dashboard still reports 5. Adds org-scoped reads to their owning modules (`listPledgesForCorpOrg`, `listComputePledgesForCorpOrg`, `listResourceGiftsForCorpOrg`, `getCorporateHours`, `getProjectSummaries`, `getRunsForCorporation`) — Reporting still owns no tables. Design: `docs/superpowers/specs/2026-09-01-corporate-csr-dashboard-design.md`.

### US-7.2 Charity impact summary — *Should*

**As a** Charity Owner, **I want** an impact summary (support gathered, hours received, outcomes) per project **so that** I can report to trustees and funders.

*Acceptance criteria (drafted and agreed 2026-09-01):*
- **Given** a project I own, **when** I open its impact summary, **then** I see support gathered (supporter count and the support/momentum score), hours received, resource gifts received, and the outcome story once it is complete.
- **Given** hours logged against my project, **when** the summary shows hours received, **then** only **approved** hours are counted; pending hours are shown separately and never added to the total (US-6.2a).
- **Given** resource gifts, **when** the summary shows what was given, **then** only **received** gifts count as delivered — "promised" is never shown as "delivered" (US-6.5).
- **Given** a project delivered by agents, **when** the summary shows delivery, **then** agent-delivered work is its own line, never merged into donated hours and never counted as support (US-11.9, US-10.4).
- **Given** a project I do not own, **when** I request its impact summary, **then** it is not found — impact data never leaks across tenants.
- **Given** a project still in delivery, **when** I open the summary, **then** it works and shows what exists so far, with no outcome section.
- ✅ **Resolved (2026-09-01).** New **Reporting** bounded context (`src/modules/reporting/`) — read-only and table-less: it composes each owning module's public read (`getProjectForOwner`, `getSupportInfo`, `getScore`, `getProjectHoursForCharity`, `listResourceGiftsForProject`, `getRunForProject`), so "hours", "support" and "delivered" keep exactly one definition each. A structural guard (`boundary.test.ts`) fails if it ever queries a table directly or reaches past a module barrel. Approved/pending hours and received/promised gifts are returned as separate figures that a caller cannot accidentally sum. Agent delivery is its own line with no compute currency. `GET /api/projects/[id]/impact`, owner-only (404 otherwise); panel on the project page. Adds `getProjectHoursForCharity` to Delivery. Design: `docs/superpowers/specs/2026-09-01-charity-impact-summary-design.md`.

> **Epic 7 product decisions (2026-09-01):**
> 1. **Reporting ships free for now.** US-7.1 is not entitlement-gated; gating is deferred to US-10.5, which will read the existing `entitlements` seam. Revisit before charging starts — the dashboard is the feature `MONETISATION_MODEL.md` sells.
> 2. **No export** in US-7.1/7.2. CSV/PDF for trustees and funders is a separate story when someone asks for it.
> 3. **All-time totals**, no date range. A financial-year filter is the likely first follow-up, so the read model keeps the underlying rows rather than only totals.
> 4. **The charity sees runs and outcomes, not currency.** Compute spend is the corporation's commercial data and stays out of the charity's impact summary.

### US-7.3 Completion & shareable outcome — *Should*
**As a** Charity Owner, **I want** to mark a project complete with an outcome story **so that** supporters and corporations see the result and share it socially.
- **Given** a project in delivery, **when** I complete it, **then** an outcome story is required — completion without one is refused, and there is no other route to `completed`.
- **Given** a completed project, **when** anyone views its public page, **then** the outcome story is shown, along with when it completed.
- **Given** a completed project, **when** its link is shared on Facebook or X, **then** the preview card leads with the outcome, not the original appeal (extends US-3.1).
- **Given** a completed project, **when** I try to re-complete it, **then** it is refused — the outcome is a published record.
- ✅ **Resolved (2026-09-01).** `completeProject` + `POST /api/projects/[id]/complete` carry the story; `'completed'` was **removed** from the generic transition route and the domain refuses it there, so there is exactly one way to complete and it always has a result to show. Story is required at 30+ characters (`project_validation` → 422 domain-side, 400 at the route schema). Adds `projects.outcome_story` and `projects.completed_at`; `completed_at` is set only by completion, so a reopen never resets it. Emits `ProjectCompleted` for future supporter/corporation fan-out (US-4.4, US-8.x). Design: `docs/superpowers/specs/2026-09-01-completion-outcome-story-design.md`.

> **Note (2026-09-01):** Epic 7's stories shipped without acceptance criteria — the only stories in the backlog lacking them. US-7.3's were written and implemented with that slice; US-7.1 and US-7.2 now carry **proposed** ACs awaiting product sign-off, along with four open questions above them.

### US-7.4 Volunteer contribution record — *Could*
**As a** Corporate Volunteer, **I want** a personal record/certificate of my donated hours and projects **so that** I can show my volunteering contribution.

### US-7.5 Corporate recognition badges — *Could*
**As a** CSR Manager, **I want** our company to earn public recognition badges for delivered projects **so that** our social responsibility is visible.

---

## Epic 8 — Notifications & Communication

### US-8.1 Activity notifications — *Must*
**As a** user, **I want** notifications for events relevant to my role (interest expressed, pledge accepted/declined, project trending, hours logged) **so that** I can act promptly.

### US-8.2 Notification preferences — *Should*
**As a** user, **I want** to choose which notifications I receive and by which channel (in-app / email) **so that** I'm not overwhelmed.
- **Given** I have never touched my preferences, **when** an event fires, **then** I get the platform default for that kind of notification — no user needs a preferences row to exist, and no backfill is ever required.
- **Given** my preferences, **when** I read them, **then** they are grouped into a handful of **kinds** I recognise (account & verification, interest & pledges, donated hours, resource gifts, delivery board, agent delivery, messages, team & membership), not a list of raw event names.
- **Given** I switch a kind off, **when** an event of that kind fires, **then** no in-app notification is written for me and no email is sent — the preference is enforced where the notification is **created**, not hidden at read time, so a silenced notification never sits unread in the database.
- **Given** I switch a kind's email on, **when** an event of that kind fires, **then an email is sent through the platform mailer**. *Honest limit:* the mailer logs in dev and is a documented no-op in production until SMTP is configured (TECH_DEBT), the same as verification email today — the preference is real, the transport is the tracked gap.
- **Given** an **essential** kind — *account & verification* (you cannot act at all until your organisation is verified) and *agent delivery* (a run is spending a corporation's money on a charity's app; a pause or halt stops delivery) — **when** I try to turn its in-app channel off, **then** it is refused: a user must not be able to configure themselves into missing a decision only they can make. Its **email** channel is still mine to turn off.
- **Given** anyone else's preferences, **when** I try to read or change them, **then** I cannot — preferences are per user and only ever the signed-in user's own.
- **Product decision (2026-09-04):** the two channels are **independent**, so *in-app off + email on* is a supported choice ("email me, don't clutter my list"). The email therefore omits the "Read it on HodorHub" link whenever no in-app copy was written, rather than sending the reader to a page that deliberately does not hold it. The alternative — making email require in-app — was rejected as taking away a reasonable preference to protect one line of copy.

### US-8.3 In-context messaging — *Should*
**As a** Charity Owner and CSR Manager, **I want** to message within a project/delivery workspace **so that** conversations stay tied to the work.
- **Given** a corporation already has a relationship with my project — expressed interest, a pledge, a resource gift or a funded compute budget — **when** either side opens the project, **then** there is one conversation for that **project and that corporation**, and it is the same thread before, during and after delivery.
- **Given** no such relationship, **when** a corporation tries to open a conversation on a project, **then** it is refused: a charity's inbox is not open to every corporation on the platform.
- **Given** a thread, **when** I post a message, **then** it is attributed to me and my organisation, ordered oldest-first, and visible to both organisations — and to nobody else, including a platform admin (**404**, not 403).
- **Given** a message is posted, **when** the other side is notified, **then** it arrives as a *messages*-kind notification and honours that person's US-8.2 preferences.
- **Given** I post repeatedly, **when** I exceed a sane per-minute rate, **then** I am rate-limited (**429**) — an unmetered write that notifies someone else is a spam vector.
- **Given** a project with several delivering corporations (US-5.4), **when** each opens its conversation, **then** they are separate threads: one corporation never sees another's messages on the same project.
- **Product decisions (2026-09-04):** author identity is the person's **email** shown to the other organisation (the AC already requires per-message attribution; `authorLabel` is the seam for US-1.5 display names) — a deliberate divergence from US-6.3, which withholds the volunteer roster, because only people who *chose to speak* are named. A **declined or withdrawn** signal still counts as a relationship, so declining a pledge never strands a conversation both sides could read yesterday. Posting requires a **verified** corporation (`expressInterest` has no verification gate, so without this an unverified corporation could open a channel with one cheap POST); reads stay open so history is never lost. Roles are **charity owner + CSR manager only** — an allocated volunteer reading their employer's commercial conversation is a leak nobody asked for, and widening later is a one-line change.
- **Known limit:** HodorHub cannot read or moderate these threads (platform admin gets 404), so US-9.1/9.2 does not reach them. Accepted for this slice; a "report this conversation" flow needs a consent-based disclosure path, not an admin backdoor.
- ✅ **Delivered 2026-09-04.** New `src/modules/messaging/` bounded context; thread identity `(project, corporation)` enforced by a unique index; relationship gate is Commitments' `hasCorporateRelationship` over all four signals; `MessagePosted` → every role-holder on the *other* side, honouring US-8.2 preferences; message text never enters an event payload, a notification payload, an email or a log line; erasure redacts rather than deletes; 10 messages/min/user (429). Routes: `GET /api/projects/[id]/conversations`, `POST /api/projects/[id]/messages`, `GET /api/threads/[id]`; page `/threads/[id]` linked from both the project page and the delivery board (closing US-6.3's deferred messaging clause). Design: `docs/superpowers/specs/2026-09-04-in-context-messaging-design.md`.

---

## Epic 9 — Trust, Safety & Administration

### US-9.1 Content moderation — *Must*
**As a** Platform Admin, **I want** to review reported projects/users and take action (warn, suspend, remove) **so that** the platform stays safe and legitimate.

### US-9.2 Report abuse — *Should*
**As a** user, **I want** to report inappropriate content or behaviour **so that** admins can review it.

### US-9.3 Prevent gaming of support scores — *Must*
**As a** Platform Admin, **I want** safeguards against fake likes/bot inflation of support scores — on-platform and via the ingested social signals — **so that** popularity signals stay trustworthy.
- **Given** support drives corporate discovery, **when** ingested engagement shows anomalous spikes (e.g. bot-like velocity), **then** it is flagged/dampened and surfaced for admin review rather than counted at face value.

> **Note:** Promoted to *Must* because the product now ranks corporate discovery on **real** ingested social engagement (US-3.5). If that score can be gamed, the core matching loop is compromised.

### US-9.4 Audit trail — *Could*
**As a** Platform Admin, **I want** an audit log of key actions (verifications, pledges, moderation) **so that** decisions are traceable.

---

## Epic 10 — Monetisation & Billing

> Model defined in [`MONETISATION_MODEL.md`](./MONETISATION_MODEL.md): **free for charities & supporters; corporate freemium SaaS**. Decide and scaffold in MVP; charge in Release 2.

### US-10.1 Plans & entitlements foundation — *Must*
**As a** Platform Admin, **I want** plans and per-organisation entitlements defined centrally **so that** features can be gated by plan without hardcoding.
- **Given** a corporation, **when** any gated feature is requested, **then** access is decided by `hasEntitlement(org, feature)` against its plan, not by scattered flags.
- ⚠️ **Found unbuilt (2026-09-01).** `plans`, `subscriptions` and `entitlements` had existed as **empty tables since migration 0000** — never seeded, never read, never tested — and `hasEntitlement` did not exist. Release 1 shipped the schema, not the foundation.
- ✅ **Resolved (2026-09-01).** New **Monetisation** context (`src/modules/monetisation/`): a code-declared plan catalogue (`starter`/`team`/`enterprise`), `hasEntitlement(org, feature)`, `assertEntitlement`, and `getEntitlementSummary`. Resolution order is charity → always entitled; per-org `entitlements` row (the US-10.8 comp/grant seam) → granted; otherwise the plan catalogue. Design: `docs/superpowers/specs/2026-09-01-monetisation-foundation-design.md`.

### US-10.2 Free by default — *Must*
**As a** CSR Manager, **I want** my company to start on a free Starter plan with clear limits **so that** we can prove value before paying.
- **Given** a newly verified corporation, **when** the workspace is created, **then** it is on Starter with enforced limits (e.g. 1 active commitment) and can complete the full core loop for free.
- ✅ **Resolved (2026-09-01).** An **absent subscription row means Starter**, so no corporation can be in a "no plan" state and no backfill was needed for organisations created before plans were wired. A cancelled subscription falls back to Starter, as does a subscription pointing at a plan code the catalogue no longer knows (losing a feature is recoverable; a 500 on every gated request is not).
- ⚠️ **Open:** the *"e.g. 1 active commitment"* limit is **not enforced**. Capping concurrent commitments changes the behaviour of a flow that already ships and would put existing corporations in breach — that is a product decision, not a refactor. Raised for sign-off before any enforcement.

### US-10.3 Charity & supporters always free — *Must*
**As a** Charity Owner and Supporter, **I want** to use everything relevant to me at no cost **so that** cost is never a barrier to the beneficiaries or the public.
- **Given** any charity or supporter action, **when** performed, **then** no paywall or plan limit is ever applied.
- ✅ **Resolved (2026-09-01).** Enforced at the root of `hasEntitlement`: a non-corporation organisation returns `true` for every feature before any plan is consulted, so there is no code path in which a charity can be refused for lack of a plan, and no call site can forget the rule.

### US-10.4 Ranking-integrity guardrail — *Must*
**As a** Platform Admin, **I want** payment tier to have **zero** effect on support scores, discovery ranking, or a charity's ability to accept/decline pledges **so that** merit — not money — drives matching.
- **Given** two projects/corporations, **when** ranking or acceptance occurs, **then** plan tier is never an input; automated tests assert scoring and discovery are payment-blind.
- ⚠️ **Gap closed (2026-09-01).** The gift-blind and agent-blind guards existed, but **nothing asserted payment-blindness** — the story's own AC was untested. `scoring-boundary.test.ts` now fails if scoring or discovery source so much as mentions `plans`, `subscriptions`, `entitlements`, `hasEntitlement` or `planCode`.

### US-RG Resource gifts are merit-blind and marketplace-neutral — *Must* (extends US-10.4)
**As a** Platform Admin, **I want** in-kind resource donations to have zero effect on support score, discovery ranking, a charity's accept/decline freedom, or marketplace branding **so that** generosity can never buy merit or visibility.
- **Given** any project, **when** support/momentum scores or discovery rank are computed, **then** resource gifts (offered, accepted, or received) are not an input — automated tests assert it, alongside the payment-blind tests (extends US-10.4).
- **Given** the neutral marketplace, **when** it renders, **then** no donor company's name/logo/brand appears on it as a result of a gift.

### US-10.5 Feature gating & upgrade prompts — *Should* (Release 2)
**As a** CSR Manager, **I want** to see when a feature needs a higher plan and how to upgrade **so that** I understand the value of paying.
- ✅ **Resolved (2026-09-01).** `assertEntitlement` throws `PlanUpgradeRequiredError` → **402 Payment Required**, deliberately not 403: this is a billing answer, not a permission one, and telling a CSR manager "forbidden" when the answer is "upgrade" is both wrong and useless. The error carries the plan that first includes the feature, so prompts are concrete. Applied to the **CSR dashboard (US-7.1)**, gated in the domain so no caller can bypass it; `/dashboard` renders an upgrade prompt rather than 404ing, and `/billing` lists the plans. This settles the Epic 7 decision-1 debt.

### US-10.6 Subscribe & manage billing — *Should* (Release 2)
**As a** CSR Manager, **I want** to subscribe to a paid plan and manage payment methods and invoices **so that** my company can access Team/Enterprise features.
- **Given** a Starter workspace, **when** I subscribe via the payment provider, **then** entitlements update and invoices are available.
- ✅ **Resolved (2026-09-01), behind a provider seam.** `PaymentProviderClient` (`src/lib/payment-provider.ts`) with `FakePaymentProvider` and an env-selected factory defaulting to `'fake'`; `'stripe'` **throws** until real keys and the SDK are wired, so a workspace can never be upgraded "for free" on a fake while an operator believes it was paid for (same rule as `getModelProvider`). Starting a checkout **writes nothing** — entitlements move only on a verified callback, so an abandoned checkout cannot upgrade anyone. Signature verification lives inside the provider adapter, so no route can trust an unsigned body; `POST /api/billing/callback` reads the raw text (not JSON) because verification must see the signed bytes. Activation is idempotent under provider retries and supersedes rather than stacks. Cancelling reverts to Starter, which is simply what an absent active subscription already means. Invoices are **fetched from the provider, never mirrored locally** — a local copy would drift the moment a refund happened there. Routes: `POST`/`DELETE /api/organisations/[id]/subscription`, `GET /api/organisations/[id]/invoices`, `POST /api/billing/callback`; `/billing` now subscribes, cancels and lists invoices.
- ⏳ **Needs credentials to go live:** `STRIPE_SECRET_KEY` + the Stripe SDK, then implement `StripePaymentProvider` against the same interface and set `PAYMENT_PROVIDER=stripe`. Nothing else changes.

### US-10.7 Seat management — *Should* (Release 2)
**As a** CSR Manager, **I want** to manage admin and volunteer seats against my plan **so that** the right people have access within our subscription.

*Acceptance criteria (drafted 2026-09-01, the story had none):*
- **Given** my plan's seat limit is reached, **when** I invite another member, **then** it is refused with **402** naming the plan that has more seats — no user record is created.
- **Given** seats in use, **when** I view them, **then** I see used vs limit and who holds each one.
- **Given** a member I remove, **when** the seat is released, **then** a new invitation succeeds again.
- **Given** the last administrator, **when** removal is attempted, **then** it is refused — an organisation with no admin could never invite anyone again.
- **Given** a charity, **when** anyone is invited, **then** no seat limit ever applies (US-10.3).
- **Given** Enterprise, **when** seats are counted, **then** the limit is unlimited, reported as `null` rather than a sentinel number.
- ✅ **Resolved (2026-09-01).** `getSeatUsage` / `assertSeatAvailable` (Monetisation) over `countMembers` / `listMembers` / `removeMember` (Identity, which owns memberships). `GET/POST /api/organisations/[id]/members` and `DELETE …/members/[userId]`. An invited member who has never signed in still holds a seat — the seat is the access, not the activity. Re-inviting an existing member is idempotent and consumes no seat, so it is still allowed at the limit. The gate runs in the route **before** `inviteMember`, which stays the unguarded primitive so seeds and fixtures can build state without tripping a plan limit (same split as `beginDelivery`, tech-debt M1).

### US-10.8 Admin plan & comp management — *Could*
**As a** Platform Admin, **I want** to manage plans, pricing, and complimentary/grant-funded accounts **so that** go-to-market and partnerships are supported.

### US-10.9 Sponsored visibility (integrity-safe) — *Won't-yet*
**As a** CSR Manager, **I want** clearly-labelled sponsored placement that does **not** affect the support score **so that** we gain visibility without corrupting merit ranking. *(Only if visual + algorithmic separation from ranking is guaranteed.)*

### US-10.10 Optional supporter donations — *Won't-yet*
**As a** Supporter, **I want** to optionally donate cash to a project **so that** I can back it financially as well as socially. *(Distinct fundraising direction; opt-in per charity; Release 3+.)*

### US-10.11 Tenant & brand resolution — *Must* (MVP foundation)
**As a** platform, **I want** every request resolved to a tenant/brand (custom domain → subdomain → org context → default) **so that** corporate branding can be layered on later without reworking the request path.
- **Given** any request, **when** it is handled, **then** a brand is resolved once and applied to SSR output; **when** no tenant brand applies, **then** the default HodorHub brand is used.
- **Given** a public marketplace route, **when** viewed by anyone, **then** it always renders the neutral HodorHub brand (never a corporate brand).

### US-10.12 Corporate branding — logo & theme — *Should* (Release 2)
**As a** CSR Manager on Team or above, **I want** to set our logo and colour theme **so that** our employees' workspace and our outward CSR microsite carry our brand.
- **Given** the branding entitlement, **when** I upload a logo and set theme colours, **then** they apply to our tenant surfaces only — not to the marketplace or ranking.

### US-10.13 Custom-domain white-label — *Could* (Release 2)
**As a** CSR Manager on Enterprise, **I want** to serve our HodorHub surfaces on our own verified domain with automatic TLS **so that** the experience is fully white-labelled.
- **Given** the Enterprise entitlement, **when** I add a domain and complete DNS verification, **then** TLS is provisioned and the domain resolves to our branded tenant.

---

## Epic 11 — Agent-Delivered Projects

> **New capability (post-Release-2 track).** When a corporation funds a compute budget, HodorHub delivers a charity's software project through a small, governed team of AI subagents working across human-approved milestones. Architecture: see [`ARCHITECTURE.md`](./ARCHITECTURE.md) (AgentDelivery bounded context) and ADR 0003 (delivered-app isolation). **Product decisions locked:** the trigger is a *funded compute budget* (a hard, non-exceedable cap); a human approves at *every milestone gate*; the MVP delivers a *running app to a staging URL*, with production promotion as a *separate privileged gate*; agent activity is *merit-blind* (extends US-10.4 / US-RG); the MVP runs on *synthetic data only*. This is a distinct path, parallel to human donated-time delivery (Epic 6) — never a substitute reported as the same thing.

### US-11.1 Fund an agent-delivery budget — *Should*
**As a** CSR Manager, **I want** to fund a compute budget for a published project **so that** HodorHub's agents can deliver it without my company donating developer hours.
- **Given** a published, eligible project, **when** I create a funded-budget pledge (a hard spend cap, in currency, for an allow-listed project template), **then** it is recorded as a `compute_pledge` with status `proposed` and awaits charity acceptance — exactly as any pledge (US-5.3).
- **Given** my funded pledge, **when** support/momentum scores or discovery rank are computed, **then** it is never an input (merit-blind; extends US-10.4 / US-RG).
- **Given** I am not a CSR Manager of a verified corporation, **when** I attempt to fund, **then** it is refused (verified-actor gate, US-1.3).

### US-11.2 Charity authorises an agent-delivery run — *Must*
**As a** Charity Owner, **I want** to review and accept or decline a funded agent-delivery offer **so that** I stay in control of who — or what — delivers my project.
- **Given** a `compute_pledge`, **when** I accept it, **then** the project moves toward *In Delivery*, an agent-delivery run is authorised, and the funded budget is escrowed against the run; **when** I decline, **then** the corporation is notified with an optional reason.
- **Given** acceptance, **when** the run is authorised, **then** no human delivery workspace is created — this is a distinct, parallel delivery path (contrast US-5.3).

### US-11.3 Human milestone gates — *Must*
**As a** Charity Owner, **I want** to approve the agents' work at each phase — requirements, design, build, delivery — **so that** nothing proceeds or ships without my sign-off.
- **Given** an authorised run, **when** the agents complete a phase, **then** it enters *awaiting review* and pauses; nothing advances until I decide (mirrors pending/approved hours, US-6.2a).
- **Given** a phase awaiting review, **when** I request changes with feedback, **then** the agents revise within the remaining budget and resubmit; **when** I approve, **then** the next phase begins; **when** I reject, **then** the run stops.
- **Given** any phase awaiting review, **when** I decide, **then** a plain-language summary and risk flags assist me, but approval is always the charity's — never automated, and never the funding corporation's (independence/merit-integrity).

### US-11.4 Non-exceedable budget & safe halt — *Must*
**As a** CSR Manager, **I want** the funded budget to be an absolute ceiling **so that** a run can never cost more than we committed.
- **Given** a run, **when** the next step's estimated worst-case cost would exceed the remaining budget, **then** the step does not start and the run halts safely (reserve-before-spend) — runaway spend is impossible by construction.
- **Given** a halted or completed run, **when** it ends, **then** committed / consumed / remaining are shown and unspent budget is released back to the corporation.

### US-11.5 Admin run controls & kill switch — *Must*
**As a** Platform Admin, **I want** to pause or stop agent-delivery runs — per run or platform-wide — **so that** I can intervene quickly if something goes wrong.
- **Given** a running run, **when** I pause or stop it, **then** the agents halt between steps, the sandbox is torn down, state is persisted, and the parties are notified.
- ✅ **Resolved (2026-08-05).** "Per workspace" does not apply to this path: an agent-delivery run creates no delivery workspace (US-11.2) — that belongs to human donated-time delivery (US-5.3, US-6.x). Scopes built: **per run** and **platform-wide**. The platform-wide control is a *reversible brake* (runs stop at their next step boundary with statuses untouched, and resume when released), not a mass halt. "Halt between steps" is the contract — an in-flight model call or build runs to completion first; interrupting in-flight work was considered and rejected (it would require changing the frozen ModelProvider/SandboxRunner seams). Sandbox teardown was already structurally guaranteed. Design: `docs/superpowers/specs/2026-08-05-agent-run-kill-switch-design.md`.

### US-11.6 Sandboxed, least-privilege agents — *Must*
**As a** Platform Admin, **I want** agents to run in an isolated sandbox with no production credentials and no ability to deploy **so that** agent-written code can never reach HodorHub's own systems or ship itself.
- **Given** any agent step, **when** it executes code, **then** it runs in an isolated sandbox with restricted egress and no access to production secrets or the marketplace database.
- **Given** a delivery, **when** an app is deployed, **then** deployment is performed by a privileged component **outside** every agent's toolset, triggered only by an approved human gate.

### US-11.7 Delivered app hosting & ownership — *Should*
**As a** Charity Owner, **I want** the delivered app hosted in isolation and owned by my charity **so that** I get a real, running result I control and can take with me.
- **Given** an approved delivery phase, **when** the app is deployed, **then** it runs on a HodorHub-hosted staging/preview URL, isolated from HodorHub's own production, with my charity recorded as its owner.
- **Given** a delivered app, **when** I request it, **then** I can export/hand over the source and data — I am never locked in.

### US-11.8 Production promotion gate — *Should*
**As a** Charity Owner, **I want** promoting the app from staging to production to be a separate, explicit approval **so that** going live is a deliberate decision, not an automatic one.
- **Given** an approved app on staging, **when** I approve promotion, **then** a privileged deployer promotes it to production; the agents never promote to production themselves.
- ✅ **Resolved (2026-09-01).** Built as **two steps in two processes**: the charity owner's `POST /api/runs/[id]/promote` records intent only (a `production` row in `deploying`, an audit entry, and a `ProductionPromotionRequested` event), and the worker — which alone holds the privileged deployer — performs the deploy on its own `agent.promote` queue. The web tier never holds deploy credentials, and a slow real deploy never sits under an HTTP request. Promotion is the **charity's** decision alone: the funding corporation and even a platform admin get 404. Preconditions are the delivery milestone `approved` plus a `live` staging environment; a promotion already `deploying`/`live` is a 409, while a `failed` one may be approved again. "The agents never promote" is enforced structurally — nothing on the agent path imports the promotion module or names `'production'` — and behaviourally, by driving a whole run and asserting every deploy was `staging`. Design: `docs/superpowers/specs/2026-09-01-production-promotion-gate-design.md`.

### US-11.9 Agent activity is merit-blind — *Must* (extends US-10.4 / US-RG)
**As a** Platform Admin, **I want** funding, running, or completing an agent delivery to have **zero** effect on support scores or discovery ranking **so that** compute money can never buy merit or visibility.
- **Given** any project, **when** support/momentum scores or discovery rank are computed, **then** compute pledges and agent-run activity are not inputs — automated tests assert it, alongside the payment- and gift-blind tests (extends `scoring-boundary` guards).

### US-11.10 Distinct attribution & audit — *Must*
**As a** Charity Owner and CSR Manager, **I want** agent-delivered work reported distinctly from human donated hours, with a full audit trail **so that** contributions are never misrepresented.
- **Given** a project's contribution view, **when** it is read, **then** agent-delivered work and human donated hours are separate, non-interchangeable categories (agent work is measured in compute/cost, not hours — no conversion between them).
- **Given** a run, **when** anyone with permission audits it, **then** every step is traceable — model, tokens, cost, phase, and each human decision.

### US-11.11 Synthetic-data-only MVP — *Must*
**As a** Platform Admin, **I want** the MVP to use only synthetic data and never send beneficiary PII to a third-party model **so that** we avoid data-protection risk while the capability is proven.
- **Given** any agent run in MVP, **when** it processes project information, **then** no beneficiary personal data enters a model prompt; real beneficiary data requires a signed DPA and residency controls (Release 2+).

### US-11.12 Eligible-template scope — *Must*
**As a** Platform Admin, **I want** agent delivery limited to an allow-list of project templates **so that** we only attempt project shapes the agents can deliver reliably.
- **Given** a funding attempt, **when** the project does not match an allow-listed template, **then** it is not eligible for agent delivery; the allow-list widens only as evals prove new shapes.
- ✅ **Resolved (2026-09-01).** The gate is about the **project**, not just the string sent: the previous `z.enum(['static-site'])` accepted a construction or legal project funded for site delivery. `src/modules/agent-delivery/templates.ts` is now the single registry — code, eligible project categories, and the `provenBy` eval evidence — and the funding zod enum, the funding form and the project page all derive from it, replacing three copies that could drift. `fundComputeBudget` calls `assertTemplateEligible(templateCode, project.category)`; an ineligible shape is **422** (`template_not_eligible`), an unknown code **400** at the schema. The corporation is not offered a funding form at all when nothing can deliver the project. **Deliberately not admin-editable:** the "widens only as evals prove new shapes" clause is a governance rule, and a runtime toggle is exactly how it would erode — widening is a reviewed PR carrying evidence. Admins get a read-only `GET /api/admin/agent-delivery/templates`. Design: `docs/superpowers/specs/2026-09-01-eligible-template-scope-design.md`.

---

> **Release 1 technical architecture:** drafted in [`ARCHITECTURE.md`](./ARCHITECTURE.md) (v0.1).

## Prioritised release plan

Sequenced so each release is independently demoable and de-risks the biggest unknowns early. The riskiest part of the product — **ingesting real social engagement** and keeping it trustworthy — is pulled forward rather than left to the end.

### Release 1 — Core loop (MVP)
*Goal: prove* **promote → gain real support → attract a corporation → deliver approved donated time** *end-to-end.*

| Order | Story | Why it's in the MVP |
|-------|-------|---------------------|
| 1 | US-1.1, US-1.2, US-1.3 | No trusted actors, no platform. Verification gates everything. |
| 2 | US-2.1, US-2.2, US-2.4 | Projects with structured resource needs are the unit of value. |
| 3 | US-3.1, US-3.2, US-3.3 | Shareable pages + on-platform support = the visible demand signal. |
| 4 | **US-3.4, US-3.5, US-9.3** | **Real social ingestion + anti-gaming.** This is the differentiator and the biggest technical risk — build and prove it in MVP, not later. |
| 5 | US-4.1, US-4.2 | Corporations must be able to discover projects ranked by real support. |
| 6 | US-5.1, US-5.2, US-5.3 | Interest → pledge → acceptance is the hand-off from demand to delivery. |
| 7 | US-6.1, US-6.2, **US-6.2a** | Allocation, hour logging, and **employer approval** — approved hours are the proof of delivered value. |
| 8 | US-8.1 | Nothing above works without event notifications tying the parties together. |
| 9 | US-10.1, US-10.2, US-10.3, US-10.4, US-10.11 | Monetisation + tenancy **foundations**: plans/entitlements seam, free-by-default, integrity guardrails, and **tenant/brand-resolution middleware** (default brand only). Cheap now, painful to retrofit. Charging and actual theming are Release 2. |

### Release 2 — Trust, retention & reporting
US-1.4, US-1.5 (team/volunteer onboarding at scale) · US-3.6 (trending) · US-3.7 (social login) · US-4.4 (watch/alerts) · US-6.3, US-6.4 (delivery workspace & progress) · US-7.1, US-7.2, US-7.3 (dashboards & impact) · US-8.2, US-8.3 (preferences & messaging) · US-9.1, US-9.2 (moderation & reporting) · US-10.5, US-10.6, US-10.7 (feature gating, subscriptions & billing, seats) · US-10.12, US-10.13 (corporate branding: logo/theme, custom-domain white-label).

### Release 3 — Scale & delight
US-2.3 (rich media) · US-3.8 (milestone posts) · US-4.3 (skill-based recommendations) · US-5.4 (co-delivery) · US-7.4, US-7.5 (volunteer records, corporate badges) · US-9.4 (audit trail).

### Future track — Agent-Delivered Projects (Epic 11)
A distinct capability track, sequenced only once the core human-delivery loop is solid. Delivered as a thin, safety-first vertical slice — provider abstraction → non-exceedable budget halt → one human-gated phase → sandbox → staging deploy — before widening the template allow-list. The MVP-blocking foundations are the same ones the architecture calls out: reserve-before-spend budget ceiling (US-11.4), merit-integrity exclusion (US-11.9), sandbox + deploy isolation (US-11.6), admin kill switch (US-11.5), and enforced human gates (US-11.3). MVP output is a running app on a staging URL (US-11.7); production promotion (US-11.8) and real beneficiary data are later.

---

## Resolved decisions (product owner)

- ✅ **Social integration depth — ingest real engagement.** We connect Facebook/Twitter accounts (US-3.4) and ingest genuine post engagement into the support score (US-3.5). This is committed to the **MVP** because it is the product's core differentiator and its largest technical/compliance risk (API terms, rate limits, auth). Consequence: anti-gaming (US-9.3) is now a **Must** in the same release.
- ✅ **Time-donation model — employer-approved.** Volunteers self-log hours (US-6.2), but hours only count toward reporting once the CSR Manager approves them (US-6.2a). Pending vs approved hours are always shown distinctly.
- ✅ **Monetisation — corporate freemium SaaS; charities & supporters always free.** Corporations subscribe for reporting/recognition/scale features; the core loop is free. Merit ranking is never for sale. Model in [`MONETISATION_MODEL.md`](./MONETISATION_MODEL.md); foundations (entitlements + guardrails) are MVP, charging is Release 2. Adds Epic 10.
- ✅ **Multi-tenant branding — seam in MVP, theming in Release 2.** The entitlement seam (US-10.1) and tenant/brand-resolution middleware (US-10.11) ship in Release 1 with the default HodorHub brand only; corporate logo/theme (US-10.12, Team) and custom-domain white-label (US-10.13, Enterprise) follow in Release 2. The neutral public marketplace is never brandable. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3.
- ✅ **Agent-delivered projects — funded, gated, staged (new Epic 11).** When a corporation funds a compute budget (a hard, non-exceedable cap), HodorHub delivers via a governed team of AI subagents through human milestone gates. The MVP ships a running app to a staging URL with production promotion as a separate privileged gate, on synthetic data only, and agent activity is merit-blind (extends US-10.4 / US-RG). It is a distinct, parallel path to human donated-time delivery, reported separately — not a replacement for it. Trigger = funded compute pledge (a new Commitments sibling aggregate); a new `AgentDelivery` bounded context owns the run lifecycle and is kept structurally out of Scoring. Architecture in [`ARCHITECTURE.md`](./ARCHITECTURE.md) + ADR 0003.

## Still-open questions

- ~~**Support-score formula**~~ → drafted in [`SUPPORT_SCORE_MODEL.md`](./SUPPORT_SCORE_MODEL.md) (v0.1). Weights and parameters still need calibration against real data.
- **Corporate volunteering-time integration:** should approved hours later sync to external corporate CSR/HR systems (e.g. Benevity-style platforms)? Deferred, but may shape the US-6.2a data model.
- **Matching intelligence:** US-4.3 is manual filtering at MVP (US-4.1/4.2); automated recommendations are Release 3.
- **Agent delivery (Epic 11):** sandbox substrate (Firecracker / Kata / gVisor / managed) and delivered-app isolation granularity — to be settled in **ADR 0003** (needs devops); which single project template ships first in the allow-list (needs product owner + engineer); budget denomination confirmed as currency-canonical with tokens as audit metadata; DPA/residency for real beneficiary data deferred to Release 2+ (MVP is synthetic-data-only).
- ~~**Monetisation / cost model**~~ → resolved in [`MONETISATION_MODEL.md`](./MONETISATION_MODEL.md); see Epic 10. Price points, seat counts, and grant strategy still need market validation.
