# Listkeeper reference

This document describes the accepted source formats, settings, note layout, stored fields, table controls, filters, presets, verdict rules, update behavior, and verification procedure.

## Accepted source formats

The **List repository** field accepts any of these forms:

```text
andyrewlee/awesome-agent-orchestrators
https://github.com/andyrewlee/awesome-agent-orchestrators
https://github.com/andyrewlee/awesome-agent-orchestrators#multi-agent-swarms
https://www.github.com/jaywcjlove/awesome-mac?tab=readme-ov-file
https://github.com/some/repo/blob/main/docs/list.md
git@github.com:owner/repo.git
```

Listkeeper removes a heading anchor, query string, trailing slash, `www.` prefix, `.git` suffix, and the GitHub SSH prefix. A `/blob/`, `/tree/`, or `/raw/` URL that points to a `.md` or `.markdown` file also fills the Markdown file path. The branch name in that URL is not stored. Listkeeper looks for the path on `main`, `master`, and then `HEAD`.

If no Markdown path is provided, Listkeeper tries `README.md`, `readme.md`, and `Readme.md`.

The source parser recognizes:

- Markdown bullets that contain a link.
- Markdown tables that contain a link in any cell.
- Level-two, level-three, and level-four headings as section names.

For a bullet, text after the link becomes the description. For a table row, the longest cleaned cell becomes the description. This rule works for common best-of tables, including tables with an index column, but a longer examples cell can be selected instead of the intended description.

The parser keeps the first occurrence of each GitHub repository. For links that do not identify a GitHub repository, it keeps the first occurrence of each URL. It ignores links to the source repository itself and to `sindresorhus/awesome`.

By default, entries without a recognized GitHub repository are omitted. Enable **Include entries with no repo** to retain closed-source applications, websites, and other external links.

The **Add a list from GitHub** dialog also accepts:

| Field | Behavior |
|---|---|
| Name | This sets the note name. When it is blank, Listkeeper derives a title from the source repository name. |
| Put it in | This sets the parent folder in the vault. Listkeeper creates missing folders. |
| Minimum stars | This contributes to the `[pass:: yes]` or `[pass:: no]` field. |
| Maximum days since last push | This contributes to the same `pass` field. An entry passes only when it meets both configured limits. |
| Include entries with no repo | This retains parsed entries that Listkeeper cannot enrich with GitHub repository data. |
| Project expectations | Software enables issue-activity and license review concerns. Reference list / complete resource leaves those out. Quiet activity alone never requires review. |
| Security advisories | This enables published advisory requests for the list, within the shared request allowance. |
| Peer lists | This accepts comma-separated `owner/repository` values and records how many configured lists contain each entry. |
| Markdown file | This sets a Markdown path when the source list is not in a README. A supported GitHub file URL fills it automatically. |
| Limit | This stops the initial parse after the stated number of entries. It is useful for testing a large source list. |

When the build succeeds, Listkeeper creates both notes, stores the list configuration, writes the initial star-count samples, records a log entry, and opens the view note.

## Settings

### GitHub token

The token is optional. With a token, Listkeeper uses GitHub's GraphQL API in batches of 15 repositories. If GitHub rejects a batch because it exceeds the query resource limit, Listkeeper divides the batch and retries the smaller groups.

Authenticated requests provide:

- stars, forks, creation date, last push, archive status, primary language, license, and up to eight topics
- open and closed issue counts, issues touched in the last 90 days, open pull requests, and merged pull requests
- default-branch commits in the last 90 days
- the latest release, releases in the last year, the security-policy flag, and GitHub's `mentionableUsers` count
- the first usable paragraph of the repository README, used when the source list has no description

For public repositories, use a fine-grained token with read access to public repository metadata. Listkeeper does not need repository write access. Follow **Create a GitHub token** in settings, paste the token into the password field, and select **Validate token** to check whether GitHub accepts it and see the remaining REST and GraphQL allowances. Tokens are sent only to `api.github.com` and are never included in notices.

Obsidian stores the token in the plugin's `data.json` file. This is plain plugin configuration inside the vault. Do not publish, sync to an untrusted location, or share that file.

### Operation without a token

Without a token, Listkeeper uses GitHub's REST API. The default allowance is 55 API requests per run, shared across every list and across metadata, star-history, and advisory-page requests. Source Markdown reads use GitHub's raw-content host and do not consume this API allowance.

Every recognized GitHub entry within the selected import limit is imported even if enrichment has not run or fails. The ordinary external-link option is independent. Unattempted enrichment goes first, followed by the least recently attempted work across all lists. Successful checks, failed attempts, and advisory-page continuation are persisted with each entry. A failing entry cannot monopolize a small request budget. Later runs, including after reload, resume incomplete work.

Response rate-limit and reset headers can pause the shared run. A pause preserves entries and last-known data; entries not yet visited remain pending. Only a completed enrichment cycle marks a list fresh for scheduling. Explicit refreshes recheck successful metadata even if another entry or history request remains incomplete. Scheduled resumes retain their progress and recheck successful metadata when it reaches the configured stale interval. Existing lists without check state become eligible for enrichment without changing their local descriptions or sections.

The unauthenticated REST response does not provide the full activity data, including the 90-day commit count or security-policy information. Missing fields remain unknown. Archive, source-removal, and advisory evidence can still require review when activity fields are missing.

Use **Requests per run without a token** to change the allowance. A token is useful for larger lists and the full field set.

### Security advisories and check coverage

Advisory collection is disabled by default and configured separately for each list. Listkeeper follows the repository-advisory endpoint's pagination and retains published advisories, links, severity, package names, affected version ranges, and patched versions when GitHub supplies them.

**Evidence / review** distinguishes pending/not checked, successful checks (including zero findings), partial checks, failed checks, and disabled advisory collection. It shows last-success dates and their age. Failed checks retain last-known fields and findings. Interrupted pagination retains old findings together with newly observed findings and resumes from the saved next page; only a complete scan replaces the previous advisory set. Missing security-policy information is unknown, not a negative result.

Advisories may describe historical versions that already have patches. Listkeeper does not know the package/version you plan to use and does not claim that it is affected.

### Schedule and startup

The schedule can be **Off**, **Daily**, or **Weekly**. The timer starts when the plugin loads and runs only while Obsidian is open. It does not run missed intervals after Obsidian has been closed. Reload Obsidian after changing the schedule.

**What the schedule does** has four modes:

| Mode | Behavior |
|---|---|
| Refresh data only | Listkeeper refreshes GitHub-derived fields and star history. |
| Sync then refresh | Listkeeper reads the source list, adds or marks entries as required, and then refreshes GitHub data. |
| Cross-list then refresh | Listkeeper recalculates peer-list counts and then refreshes GitHub data. |
| Sync, cross-list, refresh | Listkeeper performs all three operations in that order. |

**Skip unless data is older than** applies to scheduled and startup runs. A list whose completed refresh is newer than the configured number of days is skipped. Incomplete work remains eligible. Manual commands do not apply this age check.

**Also run on startup** starts the configured schedule action after the Obsidian workspace is ready, subject to the same age check.


## Note and plugin data layout

Each managed list uses one view note and one entries note:

```text
Lists/
  Best Of Agent Harnesses.md
  entries/
    Best Of Agent Harnesses.md
```

The view note contains frontmatter, a title, an entry count, a link to the entries note, and a `listkeeper` code block:

````text
```listkeeper
file: Lists/entries/Best Of Agent Harnesses.md
```
````

The code block renders the entries note as a table. If the view note already contains the correct block, Listkeeper updates the entry-count line and preserves the other text.

The entries note contains frontmatter, source sections as level-two headings, and one bullet per entry:

```markdown
## Progressive disclosure tools

- [agents.md](https://github.com/agentsmd/agents.md) — Open format for repository instructions. [name:: agents.md] [url:: https://github.com/agentsmd/agents.md] [stars:: 24216] [pushed:: 2026-08-25] [forks:: 1836] [issues:: 90] [lang:: TypeScript] [lic:: MIT] [created:: 2025-08-19] [closed:: 17] [touched:: 30] [prs:: 80] [commits:: 1] [openratio:: 0.84] [perday:: 62.9] [merged:: 24] [contributors:: 22] [engagement:: 1.7] [crit:: 0.34]
```

Dataview can read the bullets with `FLATTEN file.lists`. Each entry also has an encoded `lk` field holding source baselines and conflicts, repository aliases, check status and attempts, API star history, advisory details, and personal assessment. Preserve that field when editing the note.

The plugin directory stores:

| Path | Contents |
|---|---|
| `data.json` | This contains the token, managed-list configurations, schedule, last run, unauthenticated request budget, and selected columns. |
| `data/<tag>-history.json` | This contains up to 26 saved star-count samples per repository for one list. |
| `data/<tag>-log.txt` | This contains one timestamped line for each completed list operation. |

### Legacy one-note lists

If Listkeeper finds an older note that contains both the table block and entry bullets, it moves the bullets and their sections into the entries note. It then rebuilds the original note as the view note and records the split in the run log.

## Refresh, sync, and manual content

### Refresh

A refresh reads the current entries note and updates recognized GitHub entry lines. It preserves:

- text before the first section
- custom section headings and prose
- descriptions that you changed in the entries note
- indented sub-bullets attached to an entry
- non-entry lines and sections that you added

The refresh updates GitHub fields and star history. It does not read the source list, change an entry's section to match the source, or restore a source description over your edited description.

### Source-list sync

A sync reads the source Markdown again. It adds newly listed GitHub repositories under their source section and appends `[delisted:: yes]` to existing GitHub entries that are no longer present. It never deletes an entry.

Description and section each have an independent last-source baseline. A changed source value is applied only when the local value still matches its baseline. Otherwise, the local value stays and **Evidence / source changes** shows the incoming value. **Accept** replaces that field; **Dismiss** keeps it. Both acknowledge that incoming value so unchanged source input does not prompt again. If a newer source change arrives while the dialog is open, the action preserves it and asks you to reopen the dialog before deciding. A later source change can prompt again.

For older entries without baselines, the first successful source observation establishes them while preserving local values and exposing differences for a decision. Moves carry the entry's indented notes and links with it, leaving surrounding prose intact. Reappearing entries lose their removal flag. A failed source read preserves all saved entries and source state. The saved import limit also applies to later source comparisons.

Imported and canonical repository identities are retained together. A GitHub rename does not create a duplicate when the original source link remains. Updates are applied against the current note contents after fetching, so descriptions, sections, assessments, unknown inline fields, and attached notes edited during requests survive.

The command performs a GitHub-data refresh after the source comparison.

### Selected-project research notes

**Research**, under each repository name, opens or creates a research note for that project. New notes live in a `research/` folder beside the view note, use an owner/repository-based name, and contain only a repository link and an editable heading. Name collisions receive a numbered suffix; existing files are never overwritten or adopted just because their name matches.

The entries note attaches the note with an explicitly identified line:

```markdown
  - Research: [[Lists/research/owner--repository|My research]]
```

Listkeeper resolves this identified link relative to the entries note through Obsidian's link API, including aliases and relative paths. It ignores unrelated wikilinks. Repeating the action after reload reuses the attached note without changing its contents. If the attached link does not resolve, repair it before creating another note.

### Peer-list scan

A peer-list scan reads the README from every configured peer repository and counts how many of those lists contain each GitHub repository. The current list counts as one. Listkeeper writes `[lists:: N]` only when the count is greater than one. The command refreshes GitHub data after updating the counts.

## Converting a folder of notes

**Convert a folder of notes into a list** finds vault folders that contain Markdown files with a `repo` property in frontmatter. It lists the eligible folders with their matching note counts.

The conversion copies the supported repository fields used by the older format, including the name, repository, section, description, URLs, stars, saved star history, forks, open issues, language, license, creation and push dates, archive state, delisted state, threshold result, and peer-list count. It does not copy note bodies or arbitrary custom frontmatter properties.

Listkeeper keeps the original notes by default so you can compare the results. If you enable **Move converted notes to trash**, it writes the new view and entries notes and saves their configuration before moving only the converted Markdown files to the system trash. The source folder, unrelated notes, attachments, and nested folders stay in place.

## Fields stored on entry bullets

| Group | Field | Meaning |
|---|---|---|
| Identity | `name` | This is the display name taken from the source list. |
| Identity | `url` | This is the canonical GitHub repository URL when GitHub resolves the repository. |
| Identity | `home` | This is the original external homepage when the source link was not a GitHub URL. |
| Identity | `lang` | This is GitHub's primary-language value. |
| Identity | `lic` | This is GitHub's SPDX license identifier. |
| Identity | `created` | This is the repository creation date. |
| Identity | `topics` | These are up to eight GitHub repository topics. |
| Activity | `stars` | This is the current GitHub star count. |
| Activity | `forks` | This is the current GitHub fork count. |
| Activity | `pushed` | This is the date of the last push reported by GitHub. |
| Activity | `commits` | This is the number of default-branch commits during the last 90 days. |
| Activity | `release` | This is the latest release tag and, when available, its publication date. |
| Activity | `contributors` | This is GitHub's `mentionableUsers` count. Listkeeper uses it as an approximate contributor count, but it is not a count of unique commit authors. |
| Issues and pull requests | `issues` | This is the number of open issues. |
| Issues and pull requests | `closed` | This is the all-time number of closed issues. |
| Issues and pull requests | `touched` | This is the number of issues created or updated during the last 90 days. |
| Issues and pull requests | `prs` | This is the number of open pull requests. |
| Issues and pull requests | `merged` | This is the all-time number of merged pull requests. |
| Security | `policy` | This is `yes` or `no` when GitHub returns the security-policy flag; absent means unknown. |
| Security | `advisories` | This is the number of published repository advisories. A successful check with no published findings records zero. Last-known counts remain after failed or disabled checks. |
| Security | `severity` | This is the severity of the highest-severity published advisory returned by GitHub. |
| Security | `cve` | This is that advisory's CVE identifier or, when no CVE is available, its GHSA identifier. |
| List configuration | `pass` | This is `yes` or `no` when the list has a minimum-star or maximum-last-push-age limit. |
| List configuration | `lists` | This is the number of configured lists that contain the entry. It appears only when the count is greater than one. |
| Repository state | `archived` | This is `yes` when GitHub reports that the repository is archived. |
| Repository state | `delisted` | This is `yes` after a source sync no longer finds the repository. |
| History | `gained` | This is the net star-count difference from the most recent stored sample between 20 and 60 days old. |
| State | `lk` | This encoded state preserves check progress, API star history, advisory details, source baselines, repository aliases, and personal assessments. |

Listkeeper derives four additional fields:

| Field | Calculation and interpretation |
|---|---|
| `openratio` | Listkeeper calculates open issues divided by open plus closed issues. The field is absent when there are no issues. |
| `perday` | Listkeeper divides the current star count by the repository age in days. This is a lifetime average, not a recent growth rate. |
| `engagement` | Listkeeper calculates closed issues plus merged pull requests per 1,000 stars. The value can help compare repositories in the same list, but it does not measure users, downloads, or code quality. |
| `crit` | Listkeeper applies part of the OpenSSF criticality formula to repository age, time since the last push, the approximate contributor count, recent commits, releases, and recent issue activity. It omits organization count, comment frequency, and dependent projects. It also uses a 90-day commit window instead of the official one-year input. Do not compare this value directly with an official OpenSSF score. |

When the source list provides no description, Listkeeper uses the first suitable paragraph from the repository README. It ignores headings, quoted blocks, short paragraphs, and paragraphs dominated by links.

### API star additions and local net change

The star-history endpoint returns Unix-second week boundaries and star-addition totals. Listkeeper sums the newest four buckets whose full seven-day intervals have ended. It shows the actual start and end timestamps (end exclusive), without assuming UTC calendar-week boundaries. This is four completed weeks of additions, not 30-day net growth.

Successful history results are cached for 24 hours. History failure leaves metadata and locally collected samples usable, retains any earlier addition totals, and labels the result failed or stale. Missing four-week coverage stays unavailable. Local star-count snapshots and their `gained` calculation remain separate; Listkeeper never subtracts API additions from today's count to synthesize historical totals.

The table exposes `additions`, `period`, and `historycoverage` from the saved history state. These fields can be used in filters and column selection.

## Table behavior

The `listkeeper` code block parses every recognized bullet in the entries note and renders one row per entry.

Click a column header to sort by that column. Shift-click another header to add it as the next sort key. The arrows display the priority of each sort key. A normal click replaces the existing sort chain. Blank values always sort last.

The default selection contains these 13 columns:

```text
Verdict, Name, Activity, Assessment, New concerns, Section, Description,
Stars, Stars added / 4 weeks, Local net change, Last push, Advisories, License
```

A selected column appears only when at least one entry has a value for it. Use **Columns**, or right-click the header row, to select other available columns, show every available column, or restore the default selection. The selection is stored in the plugin settings and applies to every list.

The Verdict and Name columns remain visible while the table scrolls horizontally. A second horizontal scrollbar stays at the bottom of the visible table area. The right edge fades when more columns are available off-screen. The status text reports the number of matching rows, active filter terms, visible columns, and available columns.

Descriptions are limited to three visible lines. Hover the description, or tap **Evidence / review**, to read the full text. Hover a header to read its field description. Repository names open their GitHub URL.

The table listens for changes to its entries note and redraws when the file changes.

## Filter syntax

The filter box accepts plain words, quoted phrases, and field comparisons:

```text
stars>1000 commits>0 verdict:ok
verdict:check why:graveyard
lang:rust openratio<0.3 pushed>2026-06-01
section:memory -lic:noassertion
-"local model"
```

All active terms are combined with AND.

- A plain word or quoted phrase searches the verdict, name, description, section, language, license, and topics.
- `field:text` performs a case-insensitive substring match on one field.
- `>`, `>=`, `<`, `<=`, and `=` compare numeric fields numerically. They compare dates and other text in natural order.
- A leading `-` negates a word, phrase, or field comparison.
- `verdict` and `why` refer to the calculated verdict and its reasons.
- A term is ignored when no row contains its field.
- A numeric comparison is ignored when its comparison value is not a number.

Field names are the inline-field keys shown above.

## Presets

Presets that depend on optional fields appear only when at least one row contains that field. Other presets remain visible even when no current row matches them.

| Preset | Selection rule | Initial sort |
|---|---|---|
| All | It includes every row. | It sorts by stars in descending order. |
| Best bets, ok with high criticality | It requires an `ok` verdict, `crit` of at least 0.7, and no high or critical advisory. | It sorts by `crit` in descending order. |
| Check before installing | It requires a `check` verdict. | It sorts by stars in descending order. |
| Caution | It requires a `caution` verdict. | It sorts by stars in descending order. |
| Rising, under a year old | It requires a creation date within the last 365 days. | It sorts by `perday` in descending order. |
| Local net star change, 20–60d sample | It requires a calculated `gained` value. | It sorts by `gained` in descending order. |
| Star additions, four completed weeks | It requires an `additions` value from API history. | It sorts by `additions` in descending order. |
| Quiet, no commits in 90d | It requires `commits` to equal zero. | It sorts by stars in descending order. |
| Backlog, over half of issues open | It requires at least five open issues and `openratio` above 0.5. | It sorts by `openratio` in descending order. |
| Advisories, published CVEs | It requires at least one published advisory. | It sorts by stars in descending order. |
| Low engagement for its stars | It requires at least 1,000 stars and an `engagement` value in the bottom tenth among entries with at least 1,000 stars. | It sorts by `engagement` in ascending order. |
| Dormant, no push in a year | It requires a last-push date more than 365 days old. | It sorts by stars in descending order. |
| Above the star floor and age limit | It requires `pass` to equal `yes`. | It sorts by stars in descending order. |
| Delisted by the source | It requires `delisted` to equal `yes`. | It sorts by stars in descending order. |

## Verdict rules

The Verdict column displays one of:

- `0 ⚪ unknown`
- `1 🟢 ok`
- `2 🟡 caution`
- `3 🔴 check`

Listkeeper calculates the verdict when it draws the table. **Evidence / review** shows the reasons and the separate observed activity state. A quiet push/commit history, small contributor count, repository age, or low engagement alone does not produce a concern.

| Verdict | Exact rule |
|---|---|
| Check | The repository is archived, removed from its source, or has explicit source-deprecation evidence. Source evidence uses section words `graveyard`, `deprecated`, `abandoned`, `archived`, `unmaintained`, `discontinued`, `retired`, or `dead`, or description statements such as “is deprecated”, “no longer maintained”, and leading/parenthesized deprecation labels. Older entries without source state use their section until first source observation. |
| Caution | There is a published advisory. With software expectations, this also applies when at least 20 issues are open but fewer than one quarter of that count were touched in 90 days, or the returned license is `NOASSERTION`. Reference expectations omit the issue-activity and license concerns. |
| Ok | No concern is found in the available evidence and a successful metadata check or activity field is present. |
| Unknown | There is no concern to expose and metadata/activity evidence is absent. |

The highest applicable concern determines the automatic verdict even when other fields are unavailable. These rules do not establish safety, suitability, or security. The separate Activity column labels reference expectations, unknown activity, no push in a year, no commits in 90 days, or a recent push.

A dated personal assessment and reason can be saved from **Evidence / review**. It appears alongside the automatic verdict and survives refresh and sync. It acknowledges stable identities for the displayed findings; findings fetched while the assessment dialog is open remain unacknowledged: archive/removal, source-deprecation evidence, and advisory ID plus severity and affected/patched versions. Changes to stars or check timestamps do not invalidate it. New concerns are counted in `newfindings`; acknowledged concerns remain visible. An assessment does not certify security or suppress automatic facts.

The table also exposes `activity`, `assessment`, `newfindings`, and `coverage` for filtering and column selection. Source-conflict acceptance and dismissal are available in the same touch-accessible modal.

## File and network effects of each command

| Command | Reads | Writes |
|---|---|---|
| Add a list from GitHub | It reads the source Markdown, configured peer-list READMEs, and GitHub repository data. | It creates or updates both notes, writes the history file, stores the list configuration, appends a log line, and opens the view note. |
| Refresh every list | It reads the current entries notes and GitHub repository data. | It replaces recognized entry lines, updates the view-note count, updates history, stores the refresh date, and appends log lines. |
| Sync every list with its source | It reads each source Markdown file and GitHub data for new and existing entries. | It adds new GitHub entries, marks missing entries as delisted, performs a refresh, updates history, and appends log lines. |
| Rescan peer lists | It reads configured peer-list READMEs, the current entries notes, and GitHub data. | It updates `lists` fields, performs a refresh, updates history, and appends log lines. |
| Refresh one list | It reads the selected source, its configured peer lists, its entries note, and GitHub data. | It performs sync, peer-list scan, and refresh operations for the selected list. |
| Convert a folder of notes into a list | It reads direct Markdown children with a `repo` frontmatter property. | It creates the two-note form, writes supported history, stores the list configuration, appends a log line, and optionally moves only the converted Markdown files to trash. Originals are kept by default. |

The ribbon button performs sync, peer-list scan, and refresh for every managed list. Scheduled and startup runs perform the operation selected in **What the schedule does** and can skip recently refreshed lists.

## Verification

`test/smoke.js` loads `main.js` with a stubbed Obsidian API and fixed GitHub responses. It verifies:

- initial creation of the view and entries notes
- parsing of bullets and tables
- stored fields and derived values
- GitHub GraphQL batch splitting
- shared request budgeting, persisted retries across lists/reloads, and rate-limit resets
- paginated advisory retrieval, failure/partial coverage, and stable assessment findings
- four completed API star-history buckets, actual boundary timestamps, and caching
- independent source conflicts, legacy baselines, canonical renames, and concurrent edits
- selected research-note creation, collisions, and relative/aliased link reuse
- refresh behavior and star history
- migration of an older combined note into the two-note layout
- filter parsing, numeric and date comparisons, negation, and multi-column sorting
- default columns, presets, and verdict rules

Run it from the repository root:

```sh
node test/smoke.js
```

After changing `main.js`, copy `main.js`, `manifest.json`, and `styles.css` into a test vault. Reload the plugin with:

```sh
obsidian plugin:reload id=listkeeper
```

Then check the Obsidian developer errors:

```sh
obsidian dev:errors
```
