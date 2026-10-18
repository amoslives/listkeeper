# Listkeeper

Listkeeper turns an awesome list or best-of list on GitHub into two notes in your vault: a view note with a sortable table of every repository in the list, and an entries note with one bullet per repository. It fetches GitHub data for each repository, gives it a verdict, and refreshes on a schedule.

[![License](https://img.shields.io/github/license/amoslives/listkeeper)](LICENSE)

![A list of 195 agent harnesses displayed as a table in Obsidian. Each row shows the verdict, the name, an Actions column with Evidence / review and Research, activity, assessment, new concerns, section and description; the remaining default columns are off-screen to the right.](screenshots/hero.png)

- **The whole list in two notes.** A list of 1,000 projects becomes one view note and one entries note, not 1,000 files. The entries note keeps every value in inline fields that Dataview can read.
- **A verdict for every repository.** Documented rules turn GitHub data into `ok`, `caution`, `check` or `unknown`: archived, dropped by the source list, marked deprecated in the source text, published advisories, at least 20 open issues with under a quarter touched in 90 days, or a licence GitHub cannot identify. A dialog on each row shows the reasons and stores your dated assessment.
- **Security advisories.** With a token, each repository's published advisories are listed with severity and the affected and patched version ranges.
- **Edits survive refreshes.** A refresh replaces only the generated entry lines. Edited descriptions, your own headings and sub-bullets are kept. A sync shows what changed in the source list, and you accept or dismiss each change.
- **Star history.** Additions over the last four completed GitHub weeks from the first run, and a local net change once a stored sample between 20 and 60 days old exists.
- **No build step, no runtime dependency, no telemetry.** It runs on mobile and without a token, within GitHub's anonymous limits. An interrupted run resumes after a reload.

## How it compares

| Plugin | Starts from | Covers | What you get |
|---|---|---|---|
| Listkeeper | Any awesome list or best-of list on GitHub | Every repository in the list, in one table | A verdict per repository, published advisories, star history, source sync, scheduled refresh |
| GitHub Stars | Repository links in your own notes | Those links | Star counts |
| GitHub Stars Manager | The repositories you starred | Your star list | A side-panel view with tags, notes, search and filters |
| Import GitHub Readme | One README | One file | The README text |
| GitHub Repo Tools | A local clone of one repository | One repository | A behind-remote count with Pull, a pull request dashboard, commit, push, branch and stash actions |
| GitHub Embeds | An issue, a pull request or a code snippet | One item per embed | A rendered embed |

The verdict is a review aid, not a security guarantee or an installation recommendation.

## Using the table

The filter accepts words, quoted phrases, and field comparisons. For example:

```text
verdict:check
stars>1000 lang:rust pushed>2026-06-01
-lic:noassertion
"local model"
```

All active terms must match a row. A leading `-` excludes matches.

![The table filtered with verdict:check. Five rows remain, and their sections, activity and new concerns show why each needs a check before installing.](screenshots/filter-check.png)

Up to 14 columns are selected by default. A column appears only when at least one entry contains that field. Use **Columns**, or right-click the header row, to change the selection. Hidden columns can still be used in filters.

When you add a list, you can set the source repository, note name, vault folder, minimum star count, maximum age of the last push, software or reference-list expectations, advisory collection, peer lists, Markdown file, and an optional entry limit.

Tap **Evidence / review** in the Actions column to see automatic concerns, check dates, advisory links and version ranges, and save a dated assessment with your reason. Your assessment acknowledges the current concerns; new findings are counted separately. Quiet activity alone does not require a review. The same action exposes source-description and section conflicts with **Accept** and **Dismiss** buttons.

Tap **Research** to create a note only for the selected project, or reopen its explicitly attached research link. Your research note contains a repository link and an editable heading; fetched metadata remains in the entries note.

![The Add a list dialog with its source, name, folder, threshold, project expectation, advisory, peer-list, Markdown-file and limit fields.](screenshots/add-list.png)

On a narrow screen, the table scrolls horizontally while the Verdict and Name columns remain visible. The screenshots use the Minimal theme.

## Network use and accounts

Listkeeper connects to two GitHub hosts:

- `raw.githubusercontent.com` serves the source list's Markdown and the READMEs of any peer lists you configure.
- `api.github.com` serves repository metadata (REST without a token, GraphQL with one), star history, published security advisories when a list has them enabled, and token validation.

Requests run when you add, refresh, or sync a list, and on the schedule you choose. The plugin sends no telemetry and reads no files outside the vault.

A GitHub account is optional. Without a token, Listkeeper uses GitHub's unauthenticated limits and a per-run request allowance, and the activity fields that need GraphQL remain empty. A fine-grained token with read access to public repository metadata provides the full field set and higher limits. The token is stored in the plugin's `data.json` inside the vault and is sent only to `api.github.com`.

## Installation

Listkeeper needs Obsidian 1.13.0 or later. Install it with BRAT or from the GitHub release:

**With BRAT:** install BRAT, run **Add a beta plugin for testing**, and enter `amoslives/listkeeper`. BRAT downloads the latest Listkeeper release and handles later updates.

**Manually:** download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release. Copy them into `<vault>/.obsidian/plugins/listkeeper/`, restart Obsidian, and enable Listkeeper under **Settings > Community plugins**.

## Quick start

1. Open **Settings > Listkeeper**, follow **Create a GitHub token**, enter a fine-grained token, and select **Validate token**. For public repositories, Listkeeper only needs read access to public repository metadata; it does not need write access.
2. Run **Add a list from GitHub** from the command palette.
3. Enter `owner/repository`, a GitHub repository URL, a URL with a heading anchor, or a `/blob/` link to a Markdown file.
4. Open the generated view note. Click a header to sort, Shift-click another header to add a second sort key, type in the filter box, or select a preset.
5. If required, open **Settings > Listkeeper** and choose a daily or weekly schedule. Reload Obsidian after changing the schedule.

The token is optional. Every recognized GitHub entry within the selected import limit is saved, including entries awaiting metadata. Without a token, one allowance (55 requests by default) covers repository data, star history, and advisory pages across all lists in a run. Unattempted work goes first, followed by the least recently attempted work. Progress survives reloads and failed requests; GitHub rate-limit headers can pause the run until reset. A token provides the full activity fields and a higher rate limit.

The token is stored in the plugin's `data.json` file inside the vault. Do not publish or share that file.

Star history is cached for 24 hours. Advisory collection adds a request per page per repository, so enabling it takes more requests and time.

## Commands

| Command | What it does |
|---|---|
| Add a list from GitHub | It reads the source Markdown, fetches repository data, creates the view and entries notes, saves the first star-count sample, and opens the view note. |
| Refresh every list | It updates GitHub-derived fields and star history for every managed list. It does not read the source list again. |
| Sync every list with its source | It reads each source list again, adds newly listed GitHub repositories, marks missing repositories as delisted, and then refreshes repository data. It updates untouched descriptions and sections; local edits are preserved and conflicting source changes can be accepted or dismissed. |
| Rescan peer lists | It recalculates how many configured peer lists contain each repository and then refreshes repository data. |
| Refresh one list | It lets you choose one managed list, then syncs it, rescans its peer lists, and refreshes its repository data. |
| Convert a folder of notes into a list | It copies supported frontmatter fields into the two-note format and keeps originals by default. You can choose to trash only the converted notes after the new notes are written. Note bodies and custom properties are not copied. |

The ribbon button syncs, rescans, and refreshes every managed list.

## Presets

Some presets appear only when the required field exists in the entries note.

| Preset | What it shows |
|---|---|
| All | It shows every entry and sorts them by stars in descending order. |
| Best bets, ok with high criticality | It shows entries with an `ok` verdict, a partial OpenSSF criticality score of at least 0.7, and no high or critical advisory. |
| Check before installing | It shows entries with a `check` verdict. |
| Caution | It shows entries with a `caution` verdict. |
| Rising, under a year old | It shows repositories created within the last 365 days and sorts them by average stars per day. |
| Local net star change, 20–60d sample | It shows entries with a calculated star-count change and sorts them by that change. The calculation uses the most recent stored sample between 20 and 60 days old. |
| Star additions, four completed weeks | It shows the number of star additions across four completed API week buckets, separately from net change. |
| Quiet, no commits in 90d | It shows repositories with no commits on the default branch during the last 90 days. |
| Backlog, over half of issues open | It shows repositories with at least five open issues and an open-issue ratio above 0.5. |
| Advisories, published CVEs | It shows repositories with at least one published GitHub security advisory. |
| Low engagement for its stars | It shows repositories with at least 1,000 stars whose closed-issue and merged-pull-request rate is in the bottom tenth of comparable entries in the current list. |
| Dormant, no push in a year | It shows repositories whose last push was more than 365 days ago. |
| Above the star floor and age limit | It shows entries that meet the minimum-star and maximum-last-push-age limits configured for the list. |
| Delisted by the source | It shows entries that a later source-list sync marked as removed. |

## Data storage

```text
Lists/
  Best Of Agent Harnesses.md
  entries/
    Best Of Agent Harnesses.md
```

The first file is the view note. The file under `entries/` is the entries note. Each bullet in the entries note stores values in Obsidian inline-field syntax such as `[stars:: 120]`. Dataview can read these fields. An encoded `lk` field preserves source baselines, check progress, star-addition history, advisory details, repository aliases, and your assessment. Keep this field with its entry when editing the note.

List configuration, including the GitHub token and schedule, is stored in the plugin's `data.json`. Star history and run logs are stored in the plugin's `data/` folder.

See the [complete reference](docs/reference.md) for accepted input formats, settings, fields, formulas, verdict rules, filter syntax, scheduling, and file operations.

## Development

The source is `main.js`; there is no build step. Run the smoke test from the repository root:

```sh
node test/smoke.js
```

The test loads the plugin against a stubbed Obsidian API and fixed GitHub responses. After changing the plugin, copy the three distribution files into a test vault, reload the plugin, and check the Obsidian developer console.

## License

Listkeeper is distributed under the MIT License.
