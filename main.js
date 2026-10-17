/*
 * listkeeper — Obsidian plugin
 *
 * Turns a list on GitHub into a view note with a sortable table and an entries note
 * of bullets, and keeps every list current on a schedule. Plain CommonJS with no
 * build step: copy this file, manifest.json and styles.css into
 *   <vault>/.obsidian/plugins/listkeeper/
 * and enable it under Settings > Community plugins.
 */

const {
  Plugin, PluginSettingTab, Setting, Modal, SuggestModal, Notice, MarkdownRenderChild, Menu,
  requestUrl, TFile, normalizePath,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  token: "",
  lists: [],                   // every list the plugin manages
  schedule: "weekly",          // off | daily | weekly
  scheduleMode: "all",         // refresh | sync | crosslist | all
  runOnStartup: false,
  staleAfterDays: 7,
  noTokenBudget: 55,
  lastRun: "",
  columns: null,               // table columns to show; null means DEFAULT_COLUMNS
};

const GRAPHQL_BATCH = 15;  // 25 repos with this field set trips GitHub's per-query resource limit
const HISTORY_CAP = 26;
const DAY_MS = 24 * 60 * 60 * 1000;

const JUNK_PATHS = new Set(["blob", "tree", "raw", "releases", "issues", "pulls",
  "stargazers", "network", "commits", "graphs", "wiki", "actions", "discussions",
  "sponsors", "topics", "search", "orgs", "settings"]);

// ------------------------------------------------------------------ helpers

const today = () => window.moment().format("YYYY-MM-DD");
const ageDays = (d) => window.moment().diff(window.moment(String(d), "YYYY-MM-DD"), "days");
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function safeName(s) {
  const out = String(s).replace(/[\\/:*?"<>|#^[\]]/g, "-").trim().replace(/\.+$/, "");
  return (out || "untitled").slice(0, 90);
}

// ------------------------------------------------------------- list parsing

const BULLET = /^[*+-]\s+\[([^\]]+)\]\(([^)\s]+)[^)]*\)\s*[-–—:•]?\s*(.*)$/;
// the project link may sit in any cell: best-of style tables put an index number first
const TABLE = /^\|(?:[^|]*\|)*?[^|]*?\[([^\]]+)\]\(([^)\s]+)[^)]*\)([^|]*)\|(.*)$/;
const GH = /https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/;

function cleanText(s) {
  return (s || "")
    .replace(/\[?!\[[^\]]*\]\[[^\]]*\]\]?(\([^)]*\))?/g, "")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]{0,80}>/g, " ")
    .replace(/\s*\*\(last commit[^)]*\)\*\s*/g, " ")
    .replace(/[|*`]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:•]+|[\s\-–—:•]+$/g, "")
    .replace(/\.$/, "")
    .trim();
}

// ponytail: the longest cell of a table row is taken as the description; a table whose
// Examples column outgrows its Description column would need a header-aware pick
const longestCell = (row) => row.split("|").map(cleanText).sort((a, b) => b.length - a.length)[0];

function repoFrom(line, url) {
  for (const candidate of [url || "", line]) {
    const m = GH.exec(candidate);
    if (m) {
      const name = m[2].replace(/[.]+$/, "");
      if (!JUNK_PATHS.has(name)) return `${m[1]}/${name}`;
    }
  }
  return "";
}

function parseList(text, source) {
  const skip = new Set([String(source).toLowerCase(), "sindresorhus/awesome"]);
  const entries = [];
  const seenRepo = new Set(), seenUrl = new Set();
  let section = null, inFence = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim().startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = line.trim().match(/^#{2,4}\s+(.*)$/);
    if (h) {
      const s = h[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "").replace(/[[\]]/g, "")
        .replace(/\s+/g, " ").replace(/^[#:\-\s]+|[#:\-\s]+$/g, "");
      section = s || section;
      continue;
    }
    let m = BULLET.exec(line.trim()), kind = "bullet";
    if (!m) { m = TABLE.exec(line.trim()); kind = "table"; }
    if (!m) continue;
    const url = m[2].trim();
    if (!url.startsWith("http")) continue;
    const repo = repoFrom(line, url);
    if (repo && skip.has(repo.toLowerCase())) continue;
    if (repo && seenRepo.has(repo.toLowerCase())) continue;
    if (!repo && seenUrl.has(url.toLowerCase())) continue;
    if (repo) seenRepo.add(repo.toLowerCase()); else seenUrl.add(url.toLowerCase());
    entries.push({
      name: cleanText(m[1]) || m[1].trim(),
      url,
      section: section || "Uncategorised",
      desc: kind === "bullet" ? cleanText(m[3]) : longestCell(`${m[3]}|${m[4]}`),
      repo,
    });
  }
  return entries;
}

// ------------------------------------------------------------- github reads

/**
 * Accept anything that identifies a list: owner/repo, a repo URL, a URL with a
 * heading anchor, or a deep link straight to the markdown file. A /blob/ or
 * /tree/ link also tells us which file to read, so it is kept.
 */
function parseSource(input) {
  let s = String(input).trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .split("#")[0]
    .split("?")[0]
    .replace(/^\/+|\/+$/g, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("expected owner/repo");
  const source = `${parts[0]}/${parts[1]}`;
  let readmePath = null;
  const marker = parts[2];
  if ((marker === "blob" || marker === "tree" || marker === "raw") && parts.length > 4) {
    readmePath = parts.slice(4).join("/");          // skip the branch segment
    if (!/\.(md|markdown)$/i.test(readmePath)) readmePath = null;
  }
  return { source, readmePath };
}

async function fetchMarkdown(source, path) {
  const names = path ? [path] : ["README.md", "readme.md", "Readme.md"];
  for (const br of ["main", "master", "HEAD"]) {
    for (const fn of names) {
      const resp = await requestUrl({
        url: `https://raw.githubusercontent.com/${source}/${br}/${fn}`, throw: false });
      if (resp.status === 200) return { text: resp.text, path: fn };
    }
  }
  return { text: "", path: "" };
}

function mapGraphQL(r) {
  if (!r) return { ok: false };
  return {
    ok: true,
    canonical: r.nameWithOwner,
    stars: r.stargazerCount,
    last_push: r.pushedAt ? r.pushedAt.slice(0, 10) : undefined,
    archived: r.isArchived,
    created: (r.createdAt || "").slice(0, 10),
    forks: r.forkCount,
    open_issues: r.issues ? r.issues.totalCount : null,
    closed_issues: r.closed ? r.closed.totalCount : null,
    issues_90d: r.touched ? r.touched.totalCount : null,
    open_prs: r.prs ? r.prs.totalCount : null,
    merged_prs: r.merged ? r.merged.totalCount : null,
    closed_90d: r.closed90 ? r.closed90.totalCount : null,
    contributors: r.mentionableUsers ? r.mentionableUsers.totalCount : null,
    releases_1y: r.releases && r.releases.nodes
      ? r.releases.nodes.filter((n) => n.publishedAt && ageDays(n.publishedAt.slice(0, 10)) <= 365).length
      : null,
    commits_90d: r.defaultBranchRef && r.defaultBranchRef.target && r.defaultBranchRef.target.recent
      ? r.defaultBranchRef.target.recent.totalCount : null,
    security_policy: r.isSecurityPolicyEnabled,
    language: r.primaryLanguage ? r.primaryLanguage.name : undefined,
    license: r.licenseInfo ? r.licenseInfo.spdxId : undefined,
    release: r.latestRelease ? r.latestRelease.tagName : undefined,
    release_date: r.latestRelease ? (r.latestRelease.publishedAt || "").slice(0, 10) : "",
    topics: r.repositoryTopics && r.repositoryTopics.nodes
      ? r.repositoryTopics.nodes.map((t) => t.topic.name) : undefined,
    readme_intro: r.readme && r.readme.text ? firstParagraph(r.readme.text) : "",
  };
}

/** The repo's own opening paragraph, used when the list gives no description. */
function firstParagraph(md) {
  let text = String(md).replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const block of text.split(/\n\s*\n/)) {
    const b = cleanText(block).replace(/^#+\s*/, "");
    if (!b || block.trim().startsWith("#") || block.trim().startsWith("```")
        || block.trim().startsWith(">")) continue;
    if (b.length < 40 || (b.match(/http/g) || []).length > 1) continue;
    return b.length <= 300 ? b : `${b.slice(0, 300).replace(/\s\S*$/, "")}`;
  }
  return "";
}

// The OpenSSF criticality formula, sum of w * ln(1+S) / ln(1+max(S,T)) over sum of w, on the
// fields the plugin holds. Missing against the official score: organisation count, comment
// frequency, dependents; and commits per week come from the last 90 days, not a year.
const CRITICALITY = [   // [weight, threshold, value]
  [1, 120, (st) => ageDays(st.created) / 30.44],          // months since created
  [-1, 120, (st) => ageDays(st.last_push) / 30.44],       // months since last push
  [2, 5000, (st) => st.contributors],
  [1, 1000, (st) => st.commits_90d / (90 / 7)],           // commits per week
  [0.5, 26, (st) => st.releases_1y],
  [0.5, 5000, (st) => st.closed_90d],
  [0.5, 5000, (st) => st.issues_90d],
];

function criticality(st) {
  if (!st.created || !st.last_push) return undefined;
  if ([st.contributors, st.commits_90d, st.releases_1y, st.closed_90d, st.issues_90d]
      .some((v) => v === null || v === undefined)) return undefined;
  let sum = 0, weights = 0;
  for (const [w, t, value] of CRITICALITY) {
    const s = Math.max(0, value(st));
    sum += w * Math.log(1 + s) / Math.log(1 + Math.max(s, t));
    weights += w;
  }
  return Math.round(100 * sum / weights) / 100;
}

/** The row fields that come from GitHub, shared by first build and refresh. */
function githubFields(st) {
  const issues = (st.open_issues || 0) + (st.closed_issues || 0);
  return {
    repo: st.canonical, url: st.canonical ? `https://github.com/${st.canonical}` : undefined,
    stars: st.stars, last_push: st.last_push, archived: st.archived, forks: st.forks,
    open_issues: st.open_issues, closed_issues: st.closed_issues, issues_90d: st.issues_90d,
    open_prs: st.open_prs, commits_90d: st.commits_90d, security_policy: st.security_policy,
    advisories: st.advisories, advisory_severity: st.advisory_severity, cve: st.cve,
    merged_prs: st.merged_prs, contributors: st.contributors,
    // closed issues plus merged PRs per thousand stars; low for its size is the star-buying pattern
    engagement: st.stars >= 1 && !isEmpty(st.closed_issues) && !isEmpty(st.merged_prs)
      ? Math.round(10 * (st.closed_issues + st.merged_prs) / (st.stars / 1000)) / 10 : undefined,
    criticality: criticality(st),
    language: st.language, license: st.license, created: st.created,
    release: st.release, release_date: st.release_date, topics: st.topics,
    // derived: share of all issues still open, and stars per day since the repo was created
    open_ratio: st.closed_issues !== null && st.closed_issues !== undefined && issues
      ? Math.round(100 * st.open_issues / issues) / 100 : undefined,
    stars_per_day: st.created && st.stars !== undefined
      ? Math.round(10 * st.stars / Math.max(ageDays(st.created), 1)) / 10 : undefined,
  };
}

const SEVERITY = { critical: 4, high: 3, medium: 2, low: 1 };

const FIELD_NAMES = {
  gained: "stars_gained_30d", pushed: "last_push", issues: "open_issues", lang: "language",
  lic: "license", home: "homepage", closed: "closed_issues", touched: "issues_90d",
  prs: "open_prs", commits: "commits_90d", openratio: "open_ratio", perday: "stars_per_day",
  merged: "merged_prs", crit: "criticality", severity: "advisory_severity", lists: "list_count",
};

function entryState(line) {
  const value = /\[lk:: ([^\]]+)\]/.exec(line);
  if (!value) return {};
  try { return JSON.parse(decodeURIComponent(value[1])); }
  catch { throw new Error("Invalid Listkeeper entry state; repair the lk field before updating this entry"); }
}

function readRow(line, section) {
  const parsed = parseEntries(`## ${section}\n${line}`)[0];
  if (!parsed) return null;
  const row = { name: parsed.name, url: parsed.url, description: parsed.desc, section,
    repo: repoFrom("", parsed.url), state: entryState(line), extra: {} };
  for (const field of line.matchAll(/\[([A-Za-z][\w-]*):: ([^\]]*)\]/g)) {
    const [ , key, raw] = field;
    if (key === "lk") continue;
    const value = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    if (["archived", "delisted"].includes(key)) row[key] = value === "yes";
    else if (key === "policy") row.security_policy = value === "yes";
    else if (key === "pass") row.passes_filter = value === "yes";
    else if (key === "topics") row.topics = raw.split(", ");
    else if (FIELD_NAMES[key]) row[FIELD_NAMES[key]] = value;
    else if (["name", "url", "stars", "forks", "created", "release", "contributors", "engagement", "advisories", "cve"].includes(key)) row[key] = value;
    else row.extra[key] = raw;
  }
  return row;
}

function attachedEnd(lines, start) {
  let end = start;
  while (end < lines.length) {
    if (/^\s+\S/.test(lines[end])) { end++; continue; }
    let next = end;
    while (next < lines.length && !lines[next].trim()) next++;
    if (next > end && next < lines.length && /^\s+\S/.test(lines[next])) end = next;
    else break;
  }
  return end;
}

function identities(row) {
  return [row.repo, row.state?.source?.repo, ...(row.state?.aliases || []), row.url]
    .filter(Boolean).map((s) => s.toLowerCase());
}

function starWeeks(data, now = Date.now()) {
  if (!Array.isArray(data)) return null;
  const weeks = data.filter((w) => Number.isFinite(w.week) &&
    w.week * 1000 + 7 * DAY_MS <= now && Number.isFinite(w.total))
    .sort((a, b) => b.week - a.week).slice(0, 4);
  if (weeks.length !== 4) return null;
  return { additions: weeks.reduce((n, w) => n + w.total, 0),
    start: new Date(weeks[3].week * 1000).toISOString(), end: new Date(weeks[0].week * 1000 + 7 * DAY_MS).toISOString() };
}

function advisorySummary(items) {
  const worst = items.reduce((a, b) => (SEVERITY[b.severity] || 0) > (SEVERITY[a.severity] || 0) ? b : a, {});
  return { advisories: items.length, advisory_severity: worst.severity || "", cve: worst.cve || worst.id || "" };
}

function advisoryItem(a) {
  return { id: a.ghsa_id, cve: a.cve_id, severity: a.severity, url: a.html_url,
    versions: (a.vulnerabilities || []).map((v) => ({ package: v.package?.name,
      ecosystem: v.package?.ecosystem, affected: v.vulnerable_version_range,
      patched: v.patched_versions })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}

function sourceEvidence(entry) {
  const deprecated = /\b(?:is|was|now|has been) (?:deprecated|archived|abandoned|discontinued|retired)\b|\bno longer maintained\b|(?:^|\()(?:deprecated|unmaintained|discontinued|abandoned)(?:[).!:—-]|$)/i;
  return GRAVEYARD.test(entry.section || "") || deprecated.test(entry.desc || "") ? `${entry.section}: ${entry.desc}` : "";
}

function sourceUpdate(row, entry) {
  const state = row.state || (row.state = {});
  const source = state.source || (state.source = { repo: entry.repo });
  source.repo = source.repo || entry.repo;
  source.conflicts = source.conflicts || {};
  for (const [field, incoming] of [["description", entry.desc], ["section", entry.section]]) {
    const previous = source[field];
    if (previous === undefined) {
      source[field] = incoming;
      if (row[field] !== incoming) source.conflicts[field] = incoming;
    } else if (incoming !== previous) {
      if (row[field] === previous || row[field] === incoming ||
          (field === "description" && row[field] === source.fallback)) {
        row[field] = incoming;
        source[field] = incoming;
        delete source.conflicts[field];
      } else source.conflicts[field] = incoming;
    } else if (source.conflicts[field] !== incoming) delete source.conflicts[field];
  }
  source.evidence = sourceEvidence(entry);
  row.delisted = false;
  return row;
}

async function stateViaGraphQL(slugs, token, progress, request = requestUrl) {
  const result = new Map();
  const since = new Date(Date.now() - 90 * DAY_MS).toISOString();  // window for touched issues and commits
  const fetchBatch = async (batch) => {
    const parts = batch.map((s, n) => {
      const [owner, name] = s.split("/");
      return `r${n}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) ` +
             `{ nameWithOwner stargazerCount pushedAt isArchived createdAt forkCount ` +
             `  primaryLanguage { name } licenseInfo { spdxId } ` +
             `  issues(states: OPEN) { totalCount } ` +
             `  closed: issues(states: CLOSED) { totalCount } ` +
             `  touched: issues(filterBy: {since: "${since}"}) { totalCount } ` +
             `  prs: pullRequests(states: OPEN) { totalCount } ` +
             `  merged: pullRequests(states: MERGED) { totalCount } ` +
             `  closed90: issues(states: CLOSED, filterBy: {since: "${since}"}) { totalCount } ` +
             `  mentionableUsers { totalCount } ` +
             `  releases(orderBy: {field: CREATED_AT, direction: DESC}, first: 26) { nodes { publishedAt } } ` +
             `  isSecurityPolicyEnabled ` +
             `  defaultBranchRef { target { ... on Commit { recent: history(since: "${since}") { totalCount } } } } ` +
             `  latestRelease { tagName publishedAt } ` +
             `  repositoryTopics(first: 8) { nodes { topic { name } } } ` +
             `  readme: object(expression: "HEAD:README.md") { ... on Blob { text } } }`;
    });
    const resp = await request({
      url: "https://api.github.com/graphql",
      method: "POST",
      headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query { ${parts.join(" ")} }` }),
      throw: false,
    });
    if (!resp) return;
    if (resp.status === 401) throw new Error("GitHub rejected the token");
    let body = null;
    try { body = resp.json; } catch (err) { /* a 502 page is HTML, not JSON */ }
    const errors = (body && body.errors) || [];
    // GitHub caps the work one query may do. A batch over the cap comes back as
    // a 502, or as a 200 with most repos null and "Resource limits" errors.
    const overloaded = resp.status >= 500 ||
      errors.some((e) => /resource limits|timedout|timeout/i.test(e.message || ""));
    if (overloaded && batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      await fetchBatch(batch.slice(0, half));
      await fetchBatch(batch.slice(half));
      return;
    }
    if (resp.status !== 200) throw new Error(`GraphQL HTTP ${resp.status}`);
    const data = (body && body.data) || {};
    batch.forEach((slug, n) => result.set(slug, { ...mapGraphQL(data[`r${n}`]),
      partial: errors.some((err) => !err.path || err.path[0] === `r${n}`) }));
    if (progress) progress(result.size, slugs.length);
  };
  for (let i = 0; i < slugs.length; i += GRAPHQL_BATCH) {
    await fetchBatch(slugs.slice(i, i + GRAPHQL_BATCH));
  }
  return result;
}

async function stateViaREST(slugs, progress, request = requestUrl) {
  const result = new Map();
  let done = 0;
  for (const slug of slugs) {
    const resp = await request({
      url: `https://api.github.com/repos/${slug}`,
      headers: { Accept: "application/vnd.github+json" },
      throw: false,
    });
    if (!resp) break;
    if (resp.status !== 200) { result.set(slug, { ok: false }); continue; }
    const r = resp.json;
    result.set(slug, {
      ok: true,
      canonical: r.full_name,
      stars: r.stargazers_count,
      last_push: r.pushed_at ? r.pushed_at.slice(0, 10) : undefined,
      archived: r.archived,
      created: (r.created_at || "").slice(0, 10),
      forks: r.forks_count,
      open_issues: r.open_issues_count,
      language: r.language || undefined,
      license: r.license ? r.license.spdx_id : undefined,
      topics: r.topics,
      readme_intro: "",
    });
    done++;
    if (progress) progress(done, slugs.length);
  }
  return result;
}

// -------------------------------------------------------------- the plugin

module.exports = class Listkeeper extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.status = this.addStatusBarItem();
    this.showStatus();

    this.addRibbonIcon("list-tree", "Sync and refresh every list", () => this.run("all"));

    this.addCommand({ id: "add-list", name: "Add a list from GitHub",
      callback: () => new AddListModal(this.app, this).open() });
    this.addCommand({ id: "refresh-all", name: "Refresh every list",
      callback: () => this.run("refresh") });
    this.addCommand({ id: "sync-all", name: "Sync every list with its source",
      callback: () => this.run("sync") });
    this.addCommand({ id: "crosslist-all", name: "Rescan peer lists",
      callback: () => this.run("crosslist") });
    this.addCommand({ id: "refresh-one", name: "Refresh one list",
      callback: () => new PickListModal(this.app, this).open() });
    this.addCommand({ id: "convert-folder", name: "Convert a folder of notes into a list",
      callback: () => new ConvertModal(this.app, this).open() });
    this.addSettingTab(new ListkeeperSettingTab(this.app, this));
    // the table: a ```listkeeper block names the entries note it draws from.
    // Without a file: line it reads the note it sits in.
    this.registerMarkdownCodeBlockProcessor("listkeeper", (src, el, ctx) => {
      const named = /^\s*file:\s*(.+?)\s*$/m.exec(src);
      const path = named ? normalizePath(named[1]) : ctx.sourcePath;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) ctx.addChild(new ListTable(el, this, file));
      else el.createEl("p", { text: `listkeeper: no note at ${path}` });
    });

    if (this.settings.schedule !== "off") {
      const every = this.settings.schedule === "daily" ? DAY_MS : 7 * DAY_MS;
      this.registerInterval(window.setInterval(
        () => this.run(this.settings.scheduleMode, null, this.settings.staleAfterDays), every));
    }
    if (this.settings.runOnStartup) {
      this.app.workspace.onLayoutReady(() =>
        this.run(this.settings.scheduleMode, null, this.settings.staleAfterDays));
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  showStatus(text) {
    const last = this.settings.lastRun ? `listkeeper: ${this.settings.lastRun}` : "listkeeper";
    this.status.setText(text || last);
  }

  // ----------------------------------------------------- two notes per list
  //
  // The view note holds the ```listkeeper block and nothing else. The entries
  // note, in an entries/ subfolder beside it, holds the list itself: sections
  // are "## " headings and each entry is one bullet carrying [key:: value]
  // fields. Every write goes to the entries note; the table (see ListTable)
  // reads that note and redraws whenever it changes.

  listNotePath(cfg) {
    const parent = cfg.parent ? `${cfg.parent}/` : "";
    return normalizePath(`${parent}${safeName(cfg.label)}.md`);
  }

  entriesPath(cfg) {
    const parent = cfg.parent ? `${cfg.parent}/` : "";
    return normalizePath(`${parent}entries/${safeName(cfg.label)}.md`);
  }

  noteHead(cfg) {
    return ["---", `list: ${JSON.stringify(cfg.label)}`,
      `source: ${JSON.stringify(cfg.source)}`, "tags:", `  - ${cfg.tag}`, "---"];
  }

  /**
   * The entries note, or null when the list has none. A note holding
   * table and bullets in one file is split on first sight: the
   * bullets move to the entries note and the view note keeps the table.
   */
  async entriesFile(cfg) {
    const path = this.entriesPath(cfg);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) return file;
    const legacy = this.app.vault.getAbstractFileByPath(this.listNotePath(cfg));
    if (!(legacy instanceof TFile)) return null;
    const { blocks } = this.splitBlocks(await this.app.vault.read(legacy));
    const total = blocks.reduce((n, b) => n + b.lines.filter((l) => this.lineRepo(l)).length, 0);
    if (!total) return null;
    await this.ensureFolder(path.split("/").slice(0, -1).join("/"));
    const made = await this.app.vault.create(path, this.joinBlocks(this.noteHead(cfg), blocks));
    await this.writeViewNote(cfg, total);
    await this.logRun(cfg, `split: ${total} entries moved to ${path}`);
    return made;
  }

  /** Create the view note, or bring its entry count up to date. */
  async writeViewNote(cfg, total) {
    const path = this.listNotePath(cfg);
    const entries = this.entriesPath(cfg);
    const count = `${total} ${total === 1 ? "entry" : "entries"} from ` +
      `[${cfg.source}](https://github.com/${cfg.source}), kept in ` +
      `[[${entries.replace(/\.md$/, "")}|the entries note]]. ${TABLE_HINT}`;
    const block = `\`\`\`listkeeper\nfile: ${entries}\n\`\`\``;
    const view = [...this.noteHead(cfg), "", `# ${cfg.label}`, "", count, "", block, ""].join("\n");
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!(existing instanceof TFile)) {
      await this.ensureFolder(cfg.parent);
      await this.app.vault.create(path, view);
      return;
    }
    const text = await this.app.vault.read(existing);
    // a view note that already holds the block keeps whatever else you wrote in it
    const out = text.includes(block) ? text.replace(/^\d+ (?:entry|entries) from .*$/m, count) : view;
    if (out !== text) await this.app.vault.modify(existing, out);
  }

  /** vault.create throws ENOENT when the parent folder is missing, so make it first. */
  async ensureFolder(path) {
    if (!path || this.app.vault.getAbstractFileByPath(path)) return;
    await this.ensureFolder(path.split("/").slice(0, -1).join("/"));
    await this.app.vault.createFolder(path);
  }

  entryLine(row) {
    const fields = [];
    // many lists give no description; the project's own README opening fills that gap
    const text = row.description ?? row.readme_intro ?? "";
    const add = (k, v) => {
      if (v === undefined || v === null || v === "") return;
      fields.push(`[${k}:: ${v}]`);
    };
    add("name", row.name);
    add("url", row.url);
    add("stars", row.stars);
    add("gained", row.stars_gained_30d);
    add("pushed", row.last_push);
    add("forks", row.forks);
    add("issues", row.open_issues);
    add("lang", row.language);
    add("lic", row.license);
    add("created", row.created);
    if (row.release) {
      add("release", row.release_date ? `${row.release} (${row.release_date})` : row.release);
    }
    if (row.topics && row.topics.length) add("topics", [].concat(row.topics).join(", "));
    if (row.homepage) add("home", row.homepage);
    if (row.passes_filter !== undefined) add("pass", row.passes_filter ? "yes" : "no");
    if (row.list_count > 1) add("lists", row.list_count);
    if (row.archived) add("archived", "yes");
    if (row.delisted) add("delisted", "yes");
    add("closed", row.closed_issues);
    add("touched", row.issues_90d);
    add("prs", row.open_prs);
    add("commits", row.commits_90d);
    add("openratio", row.open_ratio);
    add("perday", row.stars_per_day);
    add("merged", row.merged_prs);
    add("contributors", row.contributors);
    add("engagement", row.engagement);
    add("crit", row.criticality);
    if (row.security_policy !== undefined) add("policy", row.security_policy ? "yes" : "no");
    if (row.advisories !== undefined) {
      add("advisories", row.advisories);
      add("severity", row.advisory_severity);
      add("cve", row.cve);
    }
    for (const [key, value] of Object.entries(row.extra || {})) add(key, value);
    if (row.state && Object.keys(row.state).length) add("lk", encodeURIComponent(JSON.stringify(row.state)));
    const link = row.url ? `[${row.name}](${row.url})` : row.name;
    const desc = text ? ` — ${text}` : "";
    return `- ${link}${desc} ${fields.join(" ")}`.replace(/\s+$/, "");
  }

  /** Split a list note into a preamble and one block per "## " heading. */
  splitBlocks(text) {
    const preamble = [];
    const blocks = [];
    let current = null;
    for (const line of text.split("\n")) {
      const h = /^##\s+(.*)$/.exec(line);
      if (h) {
        current = { heading: h[1].trim(), lines: [] };
        blocks.push(current);
        continue;
      }
      (current ? current.lines : preamble).push(line);
    }
    return { preamble, blocks };
  }

  joinBlocks(preamble, blocks) {
    const out = preamble.slice();
    for (const b of blocks) {
      while (out.length && out[out.length - 1].trim() === "") out.pop();
      out.push("", `## ${b.heading}`, "");
      const lines = b.lines.slice();
      while (lines.length && lines[0].trim() === "") lines.shift();
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      out.push(...lines);
    }
    return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
  }

  /** The repo a bullet points at, or null if the line is not an entry. */
  lineRepo(line) {
    const link = /^-\s+\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/.exec(line);
    if (!link) return null;
    const m = GH.exec(link[1]);
    return m ? `${m[1]}/${m[2]}` : null;
  }

  /**
   * Write the list note. On a first run this creates it. Afterwards it edits
   * in place: entry lines get rebuilt, everything else is left exactly as it
   * is, including your own headings, prose and indented sub-bullets.
   */
  async writeListNote(cfg, rows) {
    const path = this.entriesPath(cfg);
    const existing = await this.entriesFile(cfg);
    const bySection = {};
    for (const row of rows) {
      const sec = row.section || "Uncategorised";
      (bySection[sec] = bySection[sec] || []).push(row);
    }
    for (const items of Object.values(bySection)) {
      items.sort((a, b) => (b.stars || 0) - (a.stars || 0));
    }
    const counts = {};
    for (const [sec, items] of Object.entries(bySection)) counts[sec] = items.length;

    if (!existing) {
      const body = [];
      for (const [sec, items] of Object.entries(bySection).sort()) {
        body.push("", `## ${sec}`, "", ...items.map((r) => this.entryLine(r)));
      }
      await this.ensureFolder(path.split("/").slice(0, -1).join("/"));
      await this.app.vault.create(path, `${this.noteHead(cfg).concat(body).join("\n")}\n`);
      await this.writeViewNote(cfg, rows.length);
      return { counts, path };
    }

    let total = 0;
    await this.app.vault.process(existing, (text) => {
      const { preamble, blocks } = this.splitBlocks(text);
      const pending = new Set(rows);
      const moves = [];
      for (const block of blocks) {
        for (let i = 0; i < block.lines.length; i++) {
          if (!/^-\s+\[/.test(block.lines[i])) continue;
          const current = readRow(block.lines[i], block.heading);
          if (!current) continue;
          const patch = [...pending].find((r) => identities(r).some((id) => identities(current).includes(id)));
          if (!patch) continue;
          pending.delete(patch);
          const next = patch.update ? patch.update(current) : Object.assign(current, patch);
          if (!next) continue;
          const line = this.entryLine(next);
          if (next.section === block.heading) block.lines[i] = line;
          else {
            const end = attachedEnd(block.lines, i + 1);
            const attached = block.lines.splice(i, end - i);
            moves.push({ heading: next.section, lines: [line, ...attached.slice(1)] });
            i--;
          }
        }
      }
      for (const row of pending) {
        if (!row.update) moves.push({ heading: row.section || "Uncategorised", lines: [this.entryLine(row)] });
      }
      for (const move of moves) {
        let block = blocks.find((b) => b.heading === move.heading);
        if (!block) { block = { heading: move.heading, lines: [] }; blocks.push(block); }
        let at = block.lines.length;
        for (let i = block.lines.length - 1; i >= 0; i--) {
          if (!/^-\s+\[/.test(block.lines[i])) continue;
          at = attachedEnd(block.lines, i + 1);
          break;
        }
        block.lines.splice(at, 0, ...move.lines);
      }
      total = blocks.reduce((n, b) => n + b.lines.filter((l) => /^-\s+\[/.test(l)).length, 0);
      return this.joinBlocks(preamble, blocks);
    });
    await this.writeViewNote(cfg, total);
    return { counts, path };
  }

  /** Read every entry out of the entries note. */
  async readListNote(cfg) {
    const file = await this.entriesFile(cfg);
    if (!file) return { file: null, entries: [] };
    const text = await this.app.vault.read(file);
    const entries = [];
    let section = "Uncategorised";
    for (const line of text.split("\n")) {
      const h = /^##\s+(.*)$/.exec(line);
      if (h) { section = h[1].trim(); continue; }
      if (!/^-\s+\[/.test(line)) continue;
      const row = readRow(line, section);
      if (!row) continue;
      entries.push({ repo: row.repo, row });
    }
    return { file, entries };
  }

  async refreshMarkdown(cfg) {
    return this.refreshLists([cfg], this.newBudget(), true);
  }

  newBudget() {
    return { left: this.settings.token ? Infinity : Math.max(1, this.settings.noTokenBudget),
      paused: (this.settings.rateReset || 0) > Date.now() };
  }

  async githubRequest(req, budget) {
    if (budget.paused || budget.left <= 0) return null;
    if (new URL(req.url).origin !== "https://api.github.com") throw new Error("Unexpected GitHub API host");
    budget.left--;
    const token = (this.settings.token || "").trim();
    const resp = await requestUrl({ ...req, throw: false,
      headers: { ...req.headers, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10",
        ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    const headers = Object.fromEntries(Object.entries(resp.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (headers["x-ratelimit-remaining"] === "0" || Number(headers["x-ratelimit-remaining"]) === 0 ||
        resp.status === 429 || (resp.status === 403 && (headers["retry-after"] || /rate limit|abuse detection/i.test(resp.text || "")))) {
      budget.paused = true;
      const reset = Number(headers["x-ratelimit-reset"]) * 1000;
      const retry = headers["retry-after"] ? (Number.isFinite(Number(headers["retry-after"]))
        ? Number(headers["retry-after"]) * 1000 + Date.now() : Date.parse(headers["retry-after"])) : 0;
      this.settings.rateReset = Math.max(reset || 0, retry || 0, Date.now() + 60000);
      await this.saveSettings();
      new Notice(`GitHub requests paused until ${new Date(this.settings.rateReset).toLocaleString()}.`, 7000);
    }
    return resp;
  }

  pendingJobs(cfg, entries) {
    const jobs = [];
    for (const e of entries) {
      if (!e.repo) continue;
      const state = e.row.state;
      const metadata = state.metadata || {};
      if (metadata.status !== "ok" || metadata.cycle !== cfg.cycle)
        jobs.push({ cfg, e, kind: "metadata", attempted: metadata.attempted || 0 });
      if (!metadata.checked) continue;
      const history = state.history || {};
      if (!history.checked || Date.now() - Date.parse(history.checked) >= DAY_MS || history.status !== "ok")
        jobs.push({ cfg, e, kind: "history", attempted: history.attempted || 0 });
      const advisory = state.advisory || {};
      if (cfg.advisories && (advisory.status !== "ok" || advisory.cycle !== cfg.cycle))
        jobs.push({ cfg, e, kind: "advisory", attempted: advisory.attempted || 0 });
    }
    return jobs;
  }

  async refreshLists(configs, budget, explicit = false, staleAfterDays = 0) {
    for (const cfg of configs) {
      const { entries } = await this.readListNote(cfg);
      const stale = staleAfterDays > 0 && entries.some(({ row }) => row.state.metadata?.checked &&
        ageDays(row.state.metadata.checked) >= staleAfterDays);
      if (!cfg.cycle || explicit || stale) {
        this.settings.cycleClock = (this.settings.cycleClock || 0) + 1;
        cfg.cycle = this.settings.cycleClock;
      }
      await this.rememberList(cfg);
    }
    const attempted = new Set();
    while (!budget.paused && budget.left > 0) {
      const jobs = [];
      for (const cfg of configs) {
        const { entries } = await this.readListNote(cfg);
        jobs.push(...this.pendingJobs(cfg, entries));
      }
      const key = (j) => `${j.cfg.tag}:${j.e.row.state.source?.repo || j.e.repo}:${j.kind}`;
      const queue = jobs.filter((j) => !attempted.has(key(j))).sort((a, b) => a.attempted - b.attempted);
      const job = queue[0];
      if (!job) break;
      if (this.settings.token && job.kind === "metadata") {
        const batch = queue.filter((j) => j.kind === "metadata").slice(0, GRAPHQL_BATCH);
        let states;
        try { states = await stateViaGraphQL(batch.map((j) => j.e.repo), this.settings.token, null,
          (req) => this.githubRequest(req, budget)); }
        catch { states = new Map(batch.map((j) => [j.e.repo, { ok: false }])); }
        for (const item of batch) {
          attempted.add(key(item));
          await this.enrich(item, budget, states);
        }
      } else {
        attempted.add(key(job));
        const more = await this.enrich(job, budget);
        if (more) attempted.delete(key(job));
      }
    }
    for (const cfg of configs) {
      const { entries } = await this.readListNote(cfg);
      const pending = this.pendingJobs(cfg, entries).length;
      if (!pending) { cfg.lastRefresh = today(); cfg.cycle = null; }
      await this.rememberList(cfg);
      await this.logRun(cfg, `refresh: ${pending} enrichment tasks pending`);
    }
  }

  async enrich({ cfg, e, kind }, budget, fetched) {
    this.showStatus(`listkeeper: ${cfg.label} ${e.repo} ${kind}`);
    const before = e.row.state[kind] || {};
    const update = { ...before, attempted: Math.max(Date.now(), (this.settings.attemptClock || 0) + 1) };
    this.settings.attemptClock = update.attempted;
    await this.saveSettings();
    let fields = {}, more = false, st;
    const request = (req) => this.githubRequest(req, budget);
    try {
      if (kind === "metadata") {
        const states = fetched || (this.settings.token
          ? await stateViaGraphQL([e.repo], this.settings.token, null, request)
          : await stateViaREST([e.repo], null, request));
        st = states.get(e.repo);
        if (!st) {
          if (budget.paused) return false;
          throw new Error("Repository metadata unavailable");
        }
        if (!st.ok) throw new Error("Repository metadata unavailable");
        const available = githubFields(st);
        fields = Object.fromEntries(Object.entries(available).filter(([, v]) => v !== undefined && v !== null && v !== ""));
        update.retained = { ...before.retained };
        for (const key of Object.keys(available).filter((k) => !["advisories", "advisory_severity", "cve"].includes(k))) {
          if (key in fields) delete update.retained[key];
          else if (e.row[key] !== undefined) update.retained[key] = update.retained[key] || before.checked || "unknown";
        }
        update.status = st.partial ? "partial" : "ok";
        update.cycle = cfg.cycle;
        if (!st.partial) update.checked = new Date().toISOString();
      } else if (kind === "history") {
        const resp = await request({ url: `https://api.github.com/repos/${e.repo}/stargazers/history?per_page=6` });
        if (!resp) return false;
        const weeks = resp.status === 200 ? starWeeks(resp.json) : null;
        if (!weeks) throw new Error("Four completed star-history weeks unavailable");
        Object.assign(update, weeks, { status: "ok", checked: new Date().toISOString() });
      } else {
        const url = before.next || `https://api.github.com/repos/${e.repo}/security-advisories?per_page=100`;
        const resp = await request({ url });
        if (!resp) return false;
        if (resp.status !== 200 || !Array.isArray(resp.json)) throw new Error("Advisory check unavailable");
        const items = resp.json.filter((a) => a.state === "published").map(advisoryItem);
        const collecting = before.next ? before.collecting || [] : [];
        update.collecting = [...new Map([...collecting, ...items].map((a) => [a.id, a])).values()];
        const link = Object.entries(resp.headers || {}).find(([k]) => k.toLowerCase() === "link");
        const next = /<([^>]+)>;\s*rel="next"/.exec(link ? link[1] : "");
        update.next = next ? next[1] : null;
        update.items = update.next
          ? [...new Map([...(before.items || []), ...update.collecting].map((a) => [a.id, a])).values()]
          : update.collecting;
        update.status = update.next ? "partial" : "ok";
        if (!update.next) { update.checked = new Date().toISOString(); update.cycle = cfg.cycle; delete update.collecting; }
        fields = advisorySummary(update.items);
        more = !!update.next;
      }
      delete update.error;
    } catch (err) {
      update.status = budget.paused ? before.status || "pending" : kind === "advisory" && before.next ? "partial" : "failed";
      if (!budget.paused) update.error = kind === "metadata" ? "Metadata request failed" : kind === "history" ? "Star history unavailable" : "Advisory request failed";
    }
    if (st?.ok && Number.isFinite(st.stars)) {
      const history = await this.readStore(`${cfg.tag}-history`) || { entries: {} };
      const hist = { history: identities(e.row).map((id) => history.entries[id]).find(Boolean) || [] };
      this.updateHistory(hist, st.stars);
      history.entries[st.canonical.toLowerCase()] = hist.history;
      if (hist.stars_gained_30d !== undefined) fields.stars_gained_30d = hist.stars_gained_30d;
      await this.writeStore(`${cfg.tag}-history`, history);
    }
    await this.writeListNote(cfg, [{ ...e.row, update: (current) => {
      if (fields.repo && fields.repo.toLowerCase() !== current.repo.toLowerCase())
        current.state.aliases = [...new Set([...(current.state.aliases || []), current.repo])];
      Object.assign(current, fields);
      if (kind === "metadata" && !before.checked && !e.row.description && !current.description && st?.readme_intro) {
        current.description = st.readme_intro;
        if (current.state.source) current.state.source.fallback = st.readme_intro;
      }
      current.state[kind] = update;
      if (kind === "metadata" && st?.ok && (cfg.minStars || cfg.maxAgeDays)) {
        current.passes_filter = (!cfg.minStars || current.stars >= cfg.minStars) &&
          (!cfg.maxAgeDays || (current.last_push && ageDays(current.last_push) <= cfg.maxAgeDays));
      }
      return current;
    } }]);
    return more;
  }

  async reviewEntry(cfg, repo, assessment, reason, acknowledged) {
    const { entries } = await this.readListNote(cfg);
    const entry = entries.find((e) => identities(e.row).includes(repo.toLowerCase()));
    if (!entry) return;
    const displayed = acknowledged || findings(parseEntries(`## ${entry.row.section}\n${this.entryLine(entry.row)}`)[0], cfg).map((f) => f.id);
    await this.writeListNote(cfg, [{ ...entry.row, update: (row) => {
      row.state.review = { date: new Date().toISOString(), assessment, reason, findings: displayed };
      return row;
    } }]);
  }

  async resolveSource(cfg, repo, field, accept, expected) {
    const { entries } = await this.readListNote(cfg);
    const entry = entries.find((e) => identities(e.row).includes(repo.toLowerCase()));
    if (!entry || !["description", "section"].includes(field)) return;
    if (expected === undefined) expected = entry.row.state.source?.conflicts?.[field];
    await this.writeListNote(cfg, [{ ...entry.row, update: (row) => {
      const source = row.state.source;
      const value = source?.conflicts?.[field];
      if (value !== expected) {
        new Notice("The source change has changed. Reopen Evidence / source changes before deciding.", 7000);
        return row;
      }
      if (value !== undefined) {
        if (accept) row[field] = value;
        source[field] = value;
        delete source.conflicts[field];
      }
      return row;
    } }]);
  }

  async openResearch(cfg, repo) {
    if (this.researchBusy) return;
    this.researchBusy = true;
    try {
      const file = await this.entriesFile(cfg);
      const text = await this.app.vault.read(file);
      const lines = text.split("\n");
      const at = lines.findIndex((line) => this.lineRepo(line) && identities(readRow(line, "")).includes(repo.toLowerCase()));
      if (at < 0) return;
      const end = attachedEnd(lines, at + 1);
      const link = lines.slice(at + 1, end).map((line) => /^\s+- Research: \[\[([^\]]+)\]\]\s*$/.exec(line)).find(Boolean);
      if (link) {
        const target = link[1].split("|")[0].split("#")[0];
        const note = this.app.metadataCache.getFirstLinkpathDest(target, file.path);
        if (note instanceof TFile) await this.app.workspace.getLeaf(true).openFile(note);
        else new Notice("The attached research link does not resolve. Repair that link before creating another note.", 7000);
        return;
      }
      const folder = normalizePath(`${cfg.parent ? cfg.parent + "/" : ""}research`);
      await this.ensureFolder(folder);
      const base = `${folder}/${safeName(repo.replace("/", "--"))}`;
      let path = `${base}.md`, n = 2;
      while (this.app.vault.getAbstractFileByPath(path)) path = `${base} ${n++}.md`;
      const note = await this.app.vault.create(path, `# Research\n\n[${repo}](https://github.com/${repo})\n`);
      const wikilink = `[[${note.path.replace(/\.md$/, "")}|${repo} research]]`;
      await this.app.vault.process(file, (current) => {
        const lines = current.split("\n");
        const index = lines.findIndex((line) => this.lineRepo(line) && identities(readRow(line, "")).includes(repo.toLowerCase()));
        if (index >= 0) lines.splice(index + 1, 0, `  - Research: ${wikilink}`);
        return lines.join("\n");
      });
      await this.app.workspace.getLeaf(true).openFile(note);
    } finally { this.researchBusy = false; }
  }

  async validateToken() {
    if (!this.settings.token.trim()) return "Enter a GitHub token first.";
    try {
      const resp = await this.githubRequest({ url: "https://api.github.com/rate_limit" }, { left: 1 });
      if (resp.status === 401) return "GitHub rejected this token.";
      if (resp.status !== 200) return `Token validation unavailable (HTTP ${resp.status}).`;
      const rates = resp.json.resources || {};
      if (rates.core?.remaining > 0 && rates.graphql?.remaining > 0) {
        this.settings.rateReset = 0;
        await this.saveSettings();
      }
      return `Token accepted. REST: ${rates.core?.remaining ?? "unknown"} remaining; GraphQL: ${rates.graphql?.remaining ?? "unknown"} remaining.`;
    } catch { return "Token validation failed; check the connection and try again."; }
  }

  // ----------------------------------------------------------------- store

  storePath(tag) {
    return normalizePath(`${this.manifest.dir}/data/${tag}.json`);
  }

  async readStore(tag) {
    try {
      const raw = await this.app.vault.adapter.read(this.storePath(tag));
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  async writeStore(tag, data) {
    const dir = normalizePath(`${this.manifest.dir}/data`);
    if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
    await this.app.vault.adapter.write(this.storePath(tag), JSON.stringify(data));
  }

  /** The list configs in plugin settings. */
  storedConfigs() {
    return (this.settings.lists || []).map((c) => Object.assign({ stored: true }, c));
  }

  async rememberList(cfg) {
    const lists = (this.settings.lists || []).filter((c) => c.tag !== cfg.tag);
    lists.push({
      tag: cfg.tag, label: cfg.label, source: cfg.source, readmePath: cfg.readmePath,
      tagPrefix: cfg.tagPrefix, minStars: cfg.minStars, maxAgeDays: cfg.maxAgeDays,
      includeNonRepo: cfg.includeNonRepo, advisories: !!cfg.advisories, peers: cfg.peers,
      parent: cfg.parent || "", lastRefresh: cfg.lastRefresh || null,
      cycle: cfg.cycle || null, expectation: cfg.expectation || "software", limit: cfg.limit || null,
    });
    this.settings.lists = lists;
    await this.saveSettings();
  }

  /** Migrate a folder of one-note-per-entry notes into a list, keeping the data. */
  async convertToOneNote(cfg, trashNotes) {
    const notes = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.parent || file.parent.path !== cfg.folder) continue;
      const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter;
      if (fm && fm.repo) notes.push({ file, fm });
    }
    if (!notes.length) { new Notice("Nothing to convert.", 4000); return; }

    const rows = notes.map(({ fm }) => ({
      name: fm.app || fm.repo, section: fm.section || "Uncategorised",
      description: fm.description, readme_intro: fm.readme_intro,
      url: fm.url, homepage: fm.homepage, repo: fm.repo, stars: fm.stars,
      stars_gained_30d: fm.stars_gained_30d, forks: fm.forks,
      open_issues: fm.open_issues, language: fm.language, license: fm.license,
      created: fm.created, last_push: fm.last_push, archived: fm.archived,
      delisted: fm.delisted, passes_filter: fm.passes_filter,
      list_count: fm.list_count, history: fm.history,
    }));

    // the list note sits where the folder is, so it does not collide with it
    const parent = cfg.folder.includes("/")
      ? cfg.folder.split("/").slice(0, -1).join("/") : "";
    const target = Object.assign({}, cfg, { parent });

    const history = { entries: {} };
    for (const r of rows) {
      if (r.repo && r.history) history.entries[r.repo.toLowerCase()] = [].concat(r.history);
    }
    await this.writeStore(`${cfg.tag}-history`, { entries: history.entries, config: {} });

    const { counts } = await this.writeListNote(target, rows);
    target.lastRefresh = today();
    await this.rememberList(target);

    let trashed = 0;
    if (trashNotes) {
      for (const { file } of notes) {
        await this.app.vault.trash(file, true);
        trashed++;
      }
    }
    await this.logRun(target,
      `converted: ${rows.length} notes into a list` +
      (trashed ? `, ${trashed} old notes trashed` : ", originals kept"));
    new Notice(`${cfg.label}: ${rows.length} entries in the list` +
               (trashed ? `, ${trashed} notes moved to trash` : ""), 9000);
    const file = this.app.vault.getAbstractFileByPath(this.listNotePath(target));
    if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
  }

  storeRow(cfg, entry) {
    return {
      name: entry.name, section: entry.section, description: entry.desc, repo: entry.repo,
      homepage: entry.repo && !GH.test(entry.url) ? entry.url : undefined,
      state: { source: { repo: entry.repo, description: entry.desc, section: entry.section, evidence: sourceEvidence(entry) } },
      url: entry.repo ? `https://github.com/${entry.repo}` : entry.url, list_count: 1,
    };
  }

  /** Bring the list note in line with its source list. */
  async syncMarkdown(cfg, entries) {
    const { file, entries: current } = await this.readListNote(cfg);
    if (!file) return;
    entries = entries.slice(0, cfg.limit || undefined);
    const matched = new Set();
    const rows = current.map((e) => {
      const entry = entries.find((item) => identities(e.row).includes((item.repo || item.url).toLowerCase()));
      if (entry) matched.add(entry);
      return { ...e.row, update: (row) => {
        if (entry) return sourceUpdate(row, entry);
        row.delisted = true;
        return row;
      } };
    });
    for (const entry of entries) {
      if (!matched.has(entry) && (entry.repo || cfg.includeNonRepo)) rows.push(this.storeRow(cfg, entry));
    }
    await this.writeListNote(cfg, rows);
    await this.logRun(cfg, `sync: ${entries.length} listed, ${rows.length - current.length} added`);
  }

  // ---------------------------------------------------------------- config

  /** Every list the plugin manages. */
  loadConfigs() {
    return this.storedConfigs();
  }

  /** One line per run, appended to the log in the plugin's data folder. */
  async logRun(cfg, line) {
    const stamp = `${window.moment().format("YYYY-MM-DD HH:mm")} ${line}\n`;
    try {
      const dir = normalizePath(`${this.manifest.dir}/data`);
      if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
      await this.app.vault.adapter.append(normalizePath(`${dir}/${cfg.tag}-log.txt`), stamp);
    } catch (err) {
      console.error("list log write failed", err);
    }
  }

  // ------------------------------------------------------------ operations

  async run(mode, onlyTag, staleAfterDays) {
    let configs = this.loadConfigs();
    if (onlyTag) configs = configs.filter((c) => c.tag === onlyTag);
    if (!configs.length) {
      new Notice("No lists yet. Run \"Add a list from GitHub\" to make one.", 6000);
      return;
    }
    if (this.running) return;
    this.running = true;
    const budget = this.newBudget();
    try {
      const eligible = [];
      for (const cfg of configs) {
        const fresh = staleAfterDays > 0 && !cfg.cycle && cfg.lastRefresh && ageDays(cfg.lastRefresh) < staleAfterDays;
        const { entries } = await this.readListNote(cfg);
        const complete = entries.every(({ row }) => !row.repo || (row.state.metadata?.status === "ok" &&
          row.state.history?.status === "ok" && (!cfg.advisories || row.state.advisory?.status === "ok")));
        if (!fresh || !complete) eligible.push(cfg);
      }
      configs = eligible;
      for (const cfg of configs) {
        try {
          if (mode === "sync" || mode === "all") await this.syncList(cfg);
          if (mode === "crosslist" || mode === "all") await this.crossList(cfg);
        } catch { new Notice(`${cfg.label}: source read failed; saved entries retained.`, 7000); }
      }
      await this.refreshLists(configs, budget, !staleAfterDays, staleAfterDays);
    } finally { this.running = false; }
    this.settings.lastRun = window.moment().format("D MMM HH:mm");
    await this.saveSettings();
    this.showStatus();
  }

  updateHistory(fm, stars) {
    const stamp = today();
    const points = [].concat(fm.history || []).map(String)
      .filter((p) => p.includes(":") && !p.startsWith(stamp));
    points.push(`${stamp}:${stars}`);
    fm.history = points.slice(-HISTORY_CAP);
    let ref = null, refDate = null;
    for (const p of points.slice(0, -1)) {
      const [d, val] = p.split(":");
      const age = window.moment(stamp, "YYYY-MM-DD").diff(window.moment(d, "YYYY-MM-DD"), "days");
      if (age >= 20 && age <= 60 && (refDate === null || d > refDate)) {
        ref = parseInt(val, 10); refDate = d;
      }
    }
    if (ref !== null) { fm.stars_30d_ago = ref; fm.stars_gained_30d = stars - ref; }
  }

  async syncList(cfg) {
    const { text } = await fetchMarkdown(cfg.source, cfg.readmePath);
    if (!text) { new Notice(`${cfg.label}: could not read the source list`, 6000); return; }
    await this.syncMarkdown(cfg, parseList(text, cfg.source));
  }

  /** Which peer lists carry each repo: lower-case owner/name -> Set of peer labels. */
  async peerMembership(cfg) {
    const slugs = Object.keys(cfg.peers || {});
    if (!slugs.length) return { membership: null, scanned: 0 };
    const membership = new Map();
    let scanned = 0;
    for (const slug of slugs) {
      const { text } = await fetchMarkdown(slug, null);
      if (!text) continue;
      scanned++;
      const re = /github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const name = m[2].replace(/[.]+$/, "");
        if (JUNK_PATHS.has(name)) continue;
        const repo = `${m[1]}/${name}`.toLowerCase();
        if (repo === slug.toLowerCase()) continue;
        if (!membership.has(repo)) membership.set(repo, new Set());
        membership.get(repo).add(cfg.peers[slug]);
      }
      this.showStatus(`listkeeper: peers ${scanned}/${slugs.length}`);
    }
    return { membership, scanned };
  }

  async crossList(cfg) {
    const { membership, scanned } = await this.peerMembership(cfg);
    if (!membership) return;

    const file = await this.entriesFile(cfg);
    if (!file) return;
    const text = await this.app.vault.read(file);
    const out = [];
    let changed = 0;
    for (const line of text.split("\n")) {
      const repo = this.lineRepo(line);
      if (!repo) { out.push(line); continue; }
      const found = new Set();
      for (const id of identities(readRow(line, "")))
        for (const label of membership.get(id) || []) found.add(label);
      const count = 1 + found.size;
      let next = line.replace(/\s*\[lists:: \d+\]/, "");
      if (count > 1) next = `${next} [lists:: ${count}]`;
      if (next !== line) changed++;
      out.push(next);
    }
    if (changed) await this.app.vault.modify(file, out.join("\n"));
    const line = `crosslist: ${scanned} peer lists scanned, ${changed} entries updated`;
    new Notice(`${cfg.label} ${line}`, 7000);
    await this.logRun(cfg, line);
  }

  // ------------------------------------------------------------------ init

  /** Build a list, view note plus entries note, from a GitHub list. */
  async initList(opts) {
    const parsed = parseSource(opts.source);
    const source = parsed.source;

    new Notice(`Reading ${source}...`, 4000);
    const { text, path } = await fetchMarkdown(source, opts.readmePath || parsed.readmePath);
    if (!text) throw new Error("could not read a markdown list from that repo");

    const label = opts.name || source.split("/")[1].replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const tag = opts.tag || slugify(source.split("/")[1]);
    const cfg = {
      parent: opts.parent ? normalizePath(opts.parent) : "",
      source, readmePath: path, label, tag,
      tagPrefix: tag.includes("-") ? tag.split("-").pop() : tag,
      minStars: opts.minStars || null, maxAgeDays: opts.maxAgeDays || null,
      includeNonRepo: !!opts.includeNonRepo, advisories: !!opts.advisories, peers: opts.peers || {},
      expectation: opts.expectation || "software", limit: opts.limit || null,
    };

    const entries = parseList(text, source).slice(0, opts.limit || undefined);
    const withRepo = entries.filter((e) => e.repo);
    if (!entries.length) throw new Error("no entries recognised in that markdown");
    new Notice(`${entries.length} entries, ${withRepo.length} with a repo. Fetching...`, 5000);

    const { membership } = await this.peerMembership(cfg);
    const rows = [];
    for (const entry of entries) {
      if (!entry.repo && !cfg.includeNonRepo) continue;
      const row = this.storeRow(cfg, entry);
      if (membership && entry.repo) {
        const found = membership.get(entry.repo.toLowerCase());
        if (found?.size) row.list_count = 1 + found.size;
      }
      rows.push(row);
    }

    const { counts } = await this.writeListNote(cfg, rows);

    await this.rememberList(cfg);
    await this.refreshLists([cfg], this.newBudget());
    await this.logRun(cfg,
      `init: ${rows.length} entries, ${Object.keys(counts).length} sections`);

    new Notice(`${label}: ${rows.length} entries, ` +
               `${Object.keys(counts).length} sections`, 9000);
    this.showStatus();
    const file = this.app.vault.getAbstractFileByPath(this.listNotePath(cfg));
    if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
  }
};

// -------------------------------------------------------------- the table
//
// A ```listkeeper code block with a file: line renders every entry bullet of
// that note as one table: click a header to sort, type to filter, pick a preset.

const TABLE_HINT = "Click a header to sort, shift-click another to add a key, " +
  "type words or terms like stars>1000 to filter, or pick a preset.";

// [key, header, numeric, what the column is for: a few words shown on hover]
const COLUMNS = [
  ["verdict", "Verdict", false, "Automatic review concerns. Tap Evidence / review for facts and assessment."],
  ["name", "Name", false, "Opens the repo."],
  ["activity", "Activity", false, "Observed cadence, separate from review concerns."],
  ["assessment", "Assessment", false, "Your dated assessment; see Evidence / review for the reason."],
  ["newfindings", "New concerns", true, "Concerns not acknowledged by your last review."],
  ["coverage", "Check coverage", false, "Check status and last successful dates."],
  ["section", "Section", false, "Where the list files it."],
  ["desc", "Description", false, "What it does. Hover for the whole text."],
  ["stars", "Stars", true, "Popularity."],
  ["gained", "Local net change", true, "Net change from a local sample 20–60 days old."],
  ["additions", "Stars added / 4 weeks", true, "Star additions across four completed GitHub API weeks; not net growth."],
  ["period", "Star-addition period", false, "Actual API week boundaries, end exclusive."],
  ["historycoverage", "Star-history coverage", false, "Last successful history fetch and current status."],
  ["perday", "Stars/day", true, "Growth speed, fair across old and new repos."],
  ["pushed", "Last push", false, "Last push reported by GitHub; quiet projects may be complete."],
  ["commits", "Commits 90d", true, "Is anyone working on it this quarter?"],
  ["engagement", "Engagement /1k stars", true, "Are the stars backed by real use? Low means stars without issues or PRs."],
  ["crit", "Criticality", true, "Partial OpenSSF criticality calculation; not a safety score."],
  ["openratio", "Open ratio", true, "Share of problems still open. High means a backlog."],
  ["issues", "Open issues", true, "Size of the open problem pile."],
  ["touched", "Touched 90d", true, "Is the issue tracker being attended to?"],
  ["contributors", "Contributors", true, "Bus factor: how many people carry it."],
  ["release", "Release", false, "Latest version and when it shipped."],
  ["advisories", "Advisories", true, "Known security disclosures."],
  ["severity", "Severity", false, "How bad the worst disclosure was."],
  ["cve", "CVE", false, "Id of the worst disclosure, to look up."],
  ["policy", "Policy", false, "Is there a way to report security bugs?"],
  ["lic", "License", false, "Can you use it? NOASSERTION means read the licence yourself."],
  ["lang", "Language", false, "Main language."],
  ["created", "Created", false, "How long it has been around."],
  ["closed", "Closed", true, "How much has been resolved over its life."],
  ["prs", "Open PRs", true, "Contributions waiting for review."],
  ["merged", "Merged PRs", true, "Contributions accepted. A working team merges."],
  ["forks", "Forks", true, "How many people took their own copy."],
  ["archived", "Archived", false, "Frozen by its owner."],
  ["delisted", "Delisted", false, "The source list dropped it."],
  ["pass", "Pass", false, "Clears your star floor and age limit?"],
  ["lists", "Lists", true, "How many of your lists recommend it."],
  ["topics", "Topics", false, "What it says it is about."],
  ["home", "Homepage", false, "Its own website."],
];
const NUMERIC = new Set(COLUMNS.filter((c) => c[2]).map((c) => c[0]));
// a group row above the headers: each group runs from the named column to the next name
const GROUPS = { verdict: "Entry", stars: "Activity", engagement: "Health", advisories: "Security",
  lang: "Background", archived: "Status", topics: "Links" };
const GROUP_OF = {};
{ let g = ""; for (const [k] of COLUMNS) { g = GROUPS[k] || g; GROUP_OF[k] = g; } }
// the columns a fresh install shows; the rest are ticked on from the Columns button or the header row's context menu
const DEFAULT_COLUMNS = ["verdict", "name", "activity", "assessment", "newfindings", "section", "desc", "stars", "additions", "gained", "pushed", "advisories", "lic"];

const PRESETS = {
  "All": { sort: ["stars", -1] },
  // an ok verdict, criticality at or above VERDICT.bestCrit, and no high or critical advisory
  "Best bets, ok with high criticality": { sort: ["crit", -1], field: "crit",
    test: (r) => r.verdict === VERDICTS[1] && r.crit >= VERDICT.bestCrit && !SERIOUS.has(r.severity) },
  "Check before installing": { sort: ["stars", -1], field: "verdict",
    test: (r) => r.verdict === VERDICTS[3] },
  "Caution": { sort: ["stars", -1], field: "verdict", test: (r) => r.verdict === VERDICTS[2] },
  "Rising, under a year old": { sort: ["perday", -1],
    test: (r) => r.created && ageDays(r.created) < 365 },
  // presets with a `field` only appear once some entry carries that field
  "Local net star change, 20–60d sample": { sort: ["gained", -1], field: "gained",
    test: (r) => r.gained !== undefined },
  "Star additions, four completed weeks": { sort: ["additions", -1], field: "additions", test: (r) => r.additions !== undefined },
  "Quiet, no commits in 90d": { sort: ["stars", -1], test: (r) => r.commits === 0 },
  "Backlog, over half of issues open": { sort: ["openratio", -1],
    test: (r) => r.openratio > 0.5 && r.issues >= 5 },
  "Advisories, published CVEs": { sort: ["stars", -1], field: "advisories",
    test: (r) => r.advisories > 0 },
  // bottom decile of engagement among repos with 1000+ stars: the star-buying pattern
  "Low engagement for its stars": { sort: ["engagement", 1], field: "engagement",
    test: (r, ctx) => r.stars >= 1000 && !isEmpty(r.engagement) && r.engagement <= ctx.lowEngagement },
  "Dormant, no push in a year": { sort: ["stars", -1],
    test: (r) => r.pushed && ageDays(r.pushed) > 365 },
  "Above the star floor and age limit": { sort: ["stars", -1], field: "pass",
    test: (r) => r.pass === "yes" },
  "Delisted by the source": { sort: ["stars", -1], field: "delisted",
    test: (r) => r.delisted === "yes" },
};

/** Every entry bullet in a list note, with its inline fields parsed. */
function parseEntries(text) {
  const rows = [];
  let section = "";
  for (const line of text.split("\n")) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { section = h[1].trim(); continue; }
    const m = /^-\s+\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)\s*(?:—\s*)?(.*)/.exec(line);
    if (!m) continue;
    const row = { name: m[1], url: m[2], desc: m[3].replace(/\s*\[[A-Za-z][\w-]*:: [\s\S]*$/, "").trim(), section };
    for (const f of line.matchAll(/\[([A-Za-z][\w-]*):: ([^\]]*)\]/g)) {
      const v = f[2].trim();
      row[f[1]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    row.state = entryState(line);
    delete row.lk;
    rows.push(row);
  }
  return rows;
}

const isEmpty = (v) => v === undefined || v === null || v === "";

// ------------------------------------------------------------ the verdict
//
// The first column: ok, caution or check, computed from the bullet's own fields
// each time the table draws. The evidence action shows the reasons.

const VERDICT = { bigStars: 1000, bestCrit: 0.7 };
const SERIOUS = new Set(["critical", "high"]);
const GRAVEYARD = /\b(?:graveyard|deprecated|abandoned|archived|unmaintained|discontinued|retired|dead)\b/i;
const VERDICTS = ["0 ⚪ unknown", "1 🟢 ok", "2 🟡 caution", "3 🔴 check"];

function findings(r, ctx = {}) {
  const found = [];
  const add = (id, reason, rank) => found.push({ id, reason, rank });
  if (r.archived === "yes") add("archived", "archived on GitHub", 3);
  if (r.delisted === "yes") add("removed", "dropped by the source list", 3);
  const evidence = r.state?.source?.evidence;
  if (evidence) add(`source:${evidence}`, `source deprecation evidence: ${evidence}`, 3);
  else if (!r.state?.source && GRAVEYARD.test(r.section || ""))
    add(`source:${r.section}`, `source section indicates discontinued work: ${r.section}`, 3);
  for (const a of r.state?.advisory?.items || [])
    add(`advisory:${a.id}:${a.severity}:${JSON.stringify(a.versions)}`,
      `${a.id}: ${a.severity || "unknown severity"}; check affected and patched versions`, 2);
  if (!r.state?.advisory?.items && r.advisories > 0)
    add(`advisory:${r.cve}:${r.severity}`, "published advisories; affected version not assessed", 2);
  if (ctx.expectation !== "reference") {
    if (r.issues >= 20 && !isEmpty(r.touched) && r.touched < r.issues * 0.25)
      add("issue-activity", "under a quarter of open issues touched in 90 days", 2);
    if (r.lic === "NOASSERTION") add("license", "licence is not a standard SPDX id", 2);
  }
  return found;
}

function verdict(r, ctx = {}) {
  const found = findings(r, ctx);
  const rank = found.length ? Math.max(...found.map((f) => f.rank))
    : r.state?.metadata?.checked || !isEmpty(r.pushed) || !isEmpty(r.commits) ? 1 : 0;
  return { rank, reasons: found.map((f) => f.reason), findings: found };
}

function coverage(check, disabled = false) {
  const status = disabled ? "disabled" : check?.status || "pending / not checked";
  return `${status}${check?.attempted ? `; last attempt ${new Date(check.attempted).toISOString()}` : ""}${check?.checked ? `; last success ${check.checked} (${Math.max(0, Math.floor((Date.now() - Date.parse(check.checked)) / DAY_MS))} days ago)` : ""}`;
}

function decorateRow(r, cfg = {}) {
  const v = verdict(r, cfg);
  r.verdict = VERDICTS[v.rank];
  r.why = v.reasons.join("; ") || (v.rank ? "no review concerns in available evidence" : "metadata not checked");
  r.activity = cfg.expectation === "reference" ? "reference: cadence not judged"
    : isEmpty(r.pushed) ? "unknown" : ageDays(r.pushed) > 365 ? "quiet: no push in a year"
      : r.commits === 0 ? "quiet: no commits in 90 days" : "recent push";
  r.coverage = `Metadata ${coverage(r.state?.metadata)}; advisories ${coverage(r.state?.advisory, !cfg.advisories)}`;
  r.assessment = r.state?.review ? `${r.state.review.date}: ${r.state.review.assessment}` : "not reviewed";
  const acknowledged = r.state?.review?.findings || [];
  r.newfindings = v.findings.filter((f) => !acknowledged.includes(f.id)).length;
  r.additions = r.state?.history?.additions;
  r.period = r.state?.history?.start ? `${r.state.history.start} to ${r.state.history.end} (end exclusive)` : "";
  r.historycoverage = coverage(r.state?.history) + (r.state?.history?.checked && Date.now() - Date.parse(r.state.history.checked) >= DAY_MS ? "; stale" : "");
  return r;
}

function compare(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

// ------------------------------------------------------- filter and sort
//
// The filter box takes plain words, quoted phrases and field terms, ANDed:
//   stars>1000 lang:rust pushed>2026-06-01 -lic:noassertion "star manipulation"
// Shift-click a header to sort by more than one column.

const TERM = /^(-?)([a-z]+)(>=|<=|>|<|=|:)(.+)$/;
const SUPERSCRIPT = "¹²³⁴⁵⁶⁷⁸⁹";
const haystack = (r) => [r.verdict, r.name, r.desc, r.section, r.lang, r.lic, r.topics].join(" ").toLowerCase();

/** Terms of a query: {neg, field, op, value}; a bare word or phrase has no field. */
function parseTerms(query) {
  const terms = [];
  for (const m of String(query || "").matchAll(/(-?)"([^"]*)"|(\S+)/g)) {
    if (m[2] !== undefined) {
      if (m[2]) terms.push({ neg: m[1] === "-", value: m[2].toLowerCase() });
      continue;
    }
    const t = TERM.exec(m[3]);
    if (t) terms.push({ neg: !!t[1], field: t[2], op: t[3], value: t[4] });
    else if (m[3].length > 1 && m[3].startsWith("-")) terms.push({ neg: true, value: m[3].slice(1).toLowerCase() });
    else terms.push({ neg: false, value: m[3].toLowerCase() });
  }
  return terms;
}

/** Drop terms that cannot apply: a field no row has, or a non-number against a numeric column. */
function usableTerms(terms, rows) {
  const known = new Set();
  for (const r of rows) for (const k of Object.keys(r)) known.add(k);
  return terms.filter((t) => !t.field || (known.has(t.field) &&
    (t.op === ":" || !NUMERIC.has(t.field) || Number.isFinite(Number(t.value)))));
}

function rowMatches(r, terms) {
  return terms.every((t) => {
    let hit;
    if (!t.field) hit = haystack(r).includes(t.value);
    else if (isEmpty(r[t.field])) hit = false;
    else if (t.op === ":") hit = String(r[t.field]).toLowerCase().includes(t.value.toLowerCase());
    else {
      const want = NUMERIC.has(t.field) ? Number(t.value) : t.value;
      const c = compare(r[t.field], want);   // numbers as numbers, dates and text in natural order
      hit = t.op === "=" ? c === 0 : t.op === ">" ? c > 0 : t.op === ">=" ? c >= 0
          : t.op === "<" ? c < 0 : c <= 0;
    }
    return t.neg ? !hit : hit;
  });
}

/** Sort by a chain of [key, direction] pairs. A blank goes last on every key. */
function sortRows(rows, chain) {
  return rows.sort((a, b) => {
    for (const [key, dir] of chain) {
      const ea = isEmpty(a[key]), eb = isEmpty(b[key]);
      if (ea || eb) { if (ea !== eb) return ea - eb; continue; }
      const c = compare(a[key], b[key]);
      if (c) return c * dir;
    }
    return 0;
  });
}

class ListTable extends MarkdownRenderChild {
  constructor(el, plugin, file) {
    super(el);
    this.plugin = plugin;
    this.file = file;
    this.preset = "All";
    this.sort = [PRESETS.All.sort.slice()];   // a chain of [key, direction]
    this.query = "";
  }

  async onload() {
    await this.render();
    this.registerEvent(this.plugin.app.vault.on("modify", (f) => {
      if (f.path === this.file.path) this.render();
    }));
  }

  async render() {
    this.rows = parseEntries(await this.plugin.app.vault.cachedRead(this.file));
    this.cfg = this.plugin.loadConfigs().find((cfg) => this.plugin.entriesPath(cfg) === this.file.path);
    this.judge();
    const root = this.containerEl;
    root.empty();
    const controls = root.createDiv({ cls: "listkeeper-controls" });
    const search = controls.createEl("input", { type: "search",
      placeholder: 'Filter: words, verdict:check, why:licence, stars>1000, -lic:noassertion, "a phrase"' });
    search.title = "Terms combine with AND. field:text matches text; > >= < <= = compare numbers and dates; " +
                   "a leading - negates.";
    search.value = this.query;
    search.addEventListener("input", () => { this.query = search.value; this.draw(); });
    const select = controls.createEl("select", { cls: "dropdown" });
    const shown = Object.entries(PRESETS)
      .filter(([, p]) => !p.field || this.rows.some((r) => !isEmpty(r[p.field])));
    for (const [name] of shown) select.createEl("option", { text: name, value: name });
    if (!shown.some(([name]) => name === this.preset)) this.preset = "All";
    select.value = this.preset;
    select.addEventListener("change", () => {
      this.preset = select.value;
      this.sort = [PRESETS[this.preset].sort.slice()];
      this.draw();
    });
    const pick = controls.createEl("button", { text: "Columns" });
    pick.title = "Choose which columns to show. Right-clicking the header row does the same.";
    pick.addEventListener("click", (e) => this.columnMenu(e,
      COLUMNS.filter(([k]) => k === "name" || this.rows.some((r) => !isEmpty(r[k])))));
    this.count = controls.createSpan({ cls: "listkeeper-count" });
    // the table's own scrollbar sits below 600 rows, so a mirror of it is pinned to the
    // bottom of the view while the table is on screen; it shows on use and fades when idle
    const wrap = root.createDiv({ cls: "listkeeper-wrap" });
    this.scroller = wrap.createDiv({ cls: "listkeeper-scroll" });
    this.table = this.scroller.createEl("table", { cls: "listkeeper-rows" });
    this.bar = wrap.createDiv({ cls: "listkeeper-hbar" });
    this.bar.title = "The table continues to the right.";
    this.barInner = this.bar.createDiv();
    const follow = (from, to) => {
      if (to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft;
      this.edge();
      this.bar.addClass("is-active");
      window.clearTimeout(this.barTimer);
      this.barTimer = window.setTimeout(() => this.bar.removeClass("is-active"), 1500);
    };
    this.bar.addEventListener("scroll", () => follow(this.bar, this.scroller));
    this.scroller.addEventListener("scroll", () => follow(this.scroller, this.bar));
    this.draw();
  }

  /** The list-relative context, then a verdict on every row. */
  judge() {
    const big = this.rows.filter((r) => r.stars >= VERDICT.bigStars && !isEmpty(r.engagement))
      .map((r) => r.engagement).sort((a, b) => a - b);
    this.ctx = { lowEngagement: big.length ? big[Math.floor((big.length - 1) * 0.1)] : -1 };
    for (const r of this.rows) decorateRow(r, this.cfg || {});
  }

  draw() {
    const chain = this.sort;
    const terms = usableTerms(parseTerms(this.query), this.rows);
    const preset = PRESETS[this.preset] || PRESETS.All;
    // the chosen columns, and only those that carry a value somewhere in this list
    const chosen = new Set(this.plugin.settings.columns || DEFAULT_COLUMNS);
    const present = COLUMNS.filter(([k]) => k === "name" || this.rows.some((r) => !isEmpty(r[k])));
    const cols = present.filter(([k]) => k === "name" || chosen.has(k));
    const ctx = this.ctx;
    const rows = sortRows(
      this.rows.filter((r) => (!preset.test || preset.test(r, ctx)) && rowMatches(r, terms)), chain);

    this.table.empty();
    const thead = this.table.createEl("thead");
    thead.title = "Right-click to choose columns";
    thead.addEventListener("contextmenu", (e) => { e.preventDefault(); this.columnMenu(e, present); });
    const groups = thead.createEl("tr");
    let label = null, span = 0;
    for (const [k] of cols.concat([[null]])) {
      if (k !== null && GROUP_OF[k] === label) { span++; continue; }
      if (label !== null) groups.createEl("th", { text: label, cls: "listkeeper-group", attr: { colspan: span } });
      label = GROUP_OF[k]; span = 1;
    }
    const head = thead.createEl("tr");
    for (const [k, label, , help] of cols) {
      const at = chain.findIndex(([sk]) => sk === k);
      const rank = chain.length > 1 && at >= 0 ? SUPERSCRIPT[at] || "" : "";
      const mark = at < 0 ? "" : (chain[at][1] < 0 ? " ▼" : " ▲") + rank;
      const th = head.createEl("th", { text: label + mark, cls: "listkeeper-sortable" });
      th.title = `${help} Click to sort; shift-click to add as the next sort key.`;
      th.addEventListener("click", (e) => {
        if (e.shiftKey) {
          if (at >= 0) chain[at] = [k, -chain[at][1]];
          else chain.push([k, NUMERIC.has(k) ? -1 : 1]);
        } else {
          this.sort = [[k, at === 0 ? -chain[0][1] : NUMERIC.has(k) ? -1 : 1]];
        }
        this.draw();
      });
    }
    const body = this.table.createEl("tbody");
    for (const r of rows) {
      const tr = body.createEl("tr");
      for (const [k] of cols) {
        const td = tr.createEl("td");
        if (NUMERIC.has(k)) td.addClass("listkeeper-num");
        if (k === "desc") td.addClass("listkeeper-desc");
        const v = r[k];
        if (k === "verdict") {
          td.setText(v);
          td.title = r.why;
        } else if (k === "name") {
          const a = td.createEl("a", { text: r.name, href: r.url, cls: "external-link" });
          a.addEventListener("click", (e) => { e.preventDefault(); window.open(r.url); });
          if (this.cfg && repoFrom("", r.url)) {
            const actions = td.createDiv();
            actions.createEl("button", { text: Object.keys(r.state.source?.conflicts || {}).length ? "Evidence / source changes" : "Evidence / review" }).addEventListener("click", () =>
              new EntryReviewModal(this.plugin.app, this.plugin, this.cfg, r).open());
            actions.createEl("button", { text: "Research" }).addEventListener("click", () =>
              this.plugin.openResearch(this.cfg, repoFrom("", r.url)));
          }
        } else if (k === "desc" && !isEmpty(v)) {
          td.createDiv({ cls: "listkeeper-clamp", text: String(v) });   // wraps, three lines at most
          td.title = String(v);
        } else if (!isEmpty(v)) {
          td.setText(String(v));
        }
      }
    }
    // the first two columns stay put while the rest scrolls, so a number always sits by its repo
    const frozen = Math.min(2, cols.length);
    let left = 0;
    for (let i = 0; i < frozen; i++) {
      for (const tr of [head, ...Array.from(body.children)]) {
        const cell = tr.children[i];
        cell.addClass("listkeeper-frozen");
        if (i === frozen - 1) cell.addClass("listkeeper-frozen-last");
        cell.style.left = `${left}px`;
      }
      left += head.children[i].getBoundingClientRect().width;
    }
    this.barInner.style.width = `${this.table.getBoundingClientRect().width}px`;
    const wide = this.scroller.scrollWidth > this.scroller.clientWidth + 1;
    this.edge();
    this.count.setText(`${rows.length} of ${this.rows.length}` +
      (terms.length ? `, ${terms.length} term${terms.length === 1 ? "" : "s"}` : "") +
      `, ${cols.length} of ${present.length} columns` + (wide ? ", scroll sideways for the rest" : ""));
  }

  /** Fade the right edge while there is more table to the right. */
  edge() {
    const sc = this.scroller;
    sc.parentElement.toggleClass("listkeeper-more", sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 1);
  }

  /** The Columns button, or a right-click on the header row: tick the columns to show. */
  columnMenu(e, present) {
    const chosen = new Set(this.plugin.settings.columns || DEFAULT_COLUMNS);
    const save = async (keys) => {
      this.plugin.settings.columns = keys;
      await this.plugin.saveSettings();
      this.draw();
    };
    const menu = new Menu();
    let group = "";
    for (const [k, label] of present) {
      if (k === "name") continue;
      if (GROUP_OF[k] !== group) {
        group = GROUP_OF[k];
        menu.addItem((item) => item.setTitle(group.toUpperCase()).setDisabled(true));
      }
      menu.addItem((item) => item.setTitle(label).setChecked(chosen.has(k)).onClick(() => {
        if (chosen.has(k)) chosen.delete(k); else chosen.add(k);
        save(COLUMNS.map(([c]) => c).filter((c) => chosen.has(c)));
      }));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Show every column").onClick(() => save(COLUMNS.map(([c]) => c))));
    menu.addItem((item) => item.setTitle("Back to the default columns").onClick(() => save(null)));
    menu.showAtMouseEvent(e);
  }
}

module.exports.parseEntries = parseEntries;
module.exports.parseList = parseList;
module.exports.verdict = verdict;
module.exports.VERDICTS = VERDICTS;
module.exports.COLUMNS = COLUMNS;
module.exports.DEFAULT_COLUMNS = DEFAULT_COLUMNS;
module.exports.parseTerms = parseTerms;
module.exports.usableTerms = usableTerms;
module.exports.rowMatches = rowMatches;
module.exports.sortRows = sortRows;
module.exports.PRESETS = PRESETS;
module.exports.starWeeks = starWeeks;
module.exports.decorateRow = decorateRow;
module.exports.findings = findings;

// ------------------------------------------------------------------ modals

class EntryReviewModal extends Modal {
  constructor(app, plugin, cfg, row) {
    super(app);
    Object.assign(this, { plugin, cfg, row });
  }

  onOpen() {
    const r = this.row, el = this.contentEl, repo = repoFrom("", r.url);
    el.createEl("h2", { text: r.name });
    el.createEl("p", { text: r.desc });
    el.createEl("p", { text: `${r.verdict}: ${r.why}` });
    el.createEl("p", { text: `${r.activity}. ${r.coverage}` });
    el.createEl("p", { text: `Security policy: ${r.policy || "unknown"}. Star history: ${r.historycoverage}` });
    for (const [field, checked] of Object.entries(r.state.metadata?.retained || {}))
      el.createEl("p", { text: `Retained ${field}: last checked ${checked}` });
    if (r.additions !== undefined) el.createEl("p", { text: `${r.additions} stars added over four completed weeks: ${r.period}` });
    el.createEl("p", { text: `${r.assessment}; unacknowledged concerns: ${r.newfindings}. ${r.state.review?.reason || ""}` });
    for (const a of r.state.advisory?.items || []) {
      const p = el.createEl("p");
      p.createEl("a", { text: `${a.id} (${a.severity || "unknown"})`, href: a.url || `https://github.com/advisories/${a.id}` });
      for (const v of a.versions || []) p.createEl("div", {
        text: `${v.ecosystem || ""} ${v.package || ""}: affected ${v.affected || "unknown"}; patched ${v.patched || "not supplied"}` });
    }
    if (r.advisories) el.createEl("p", { text: "Published advisories can describe historical versions. Your chosen package and version have not been assessed." });
    let assessment = r.state.review?.assessment || "reviewed", reason = r.state.review?.reason || "";
    new Setting(el).setName("Assessment").addDropdown((d) => d.addOptions({ reviewed: "Reviewed", suitable: "Suitable for my use", avoid: "Avoid for my use", investigate: "Investigate" })
      .setValue(assessment).onChange((v) => { assessment = v; }));
    new Setting(el).setName("Reason").addTextArea((t) => t.setValue(reason).onChange((v) => { reason = v; }));
    new Setting(el).addButton((b) => b.setButtonText("Save assessment").setCta().onClick(async () => {
      await this.plugin.reviewEntry(this.cfg, repo, assessment, reason, findings(r, this.cfg).map((f) => f.id)); this.close();
    }));
    for (const [field, incoming] of Object.entries(r.state.source?.conflicts || {})) {
      new Setting(el).setName(`Source ${field} changed`).setDesc(`Incoming: ${incoming}`)
        .addButton((b) => b.setButtonText("Accept").onClick(async () => {
          await this.plugin.resolveSource(this.cfg, repo, field, true, incoming); this.close();
        }))
        .addButton((b) => b.setButtonText("Dismiss").onClick(async () => {
          await this.plugin.resolveSource(this.cfg, repo, field, false, incoming); this.close();
        }));
    }
  }

  onClose() { this.contentEl.empty(); }
}

class AddListModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.values = { source: "", name: "", parent: "", minStars: "", maxAgeDays: "",
                    includeNonRepo: false, peers: "", limit: "", readmePath: "" };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Add a list from GitHub" });

    new Setting(contentEl).setName("List repository").setDesc("owner/repo, or its GitHub URL")
      .addText((t) => t.setPlaceholder("sindresorhus/awesome-nodejs")
        .onChange((v) => { this.values.source = v.trim(); }));
    new Setting(contentEl).setName("Name").setDesc("Note name. Derived from the repo if left blank.")
      .addText((t) => t.onChange((v) => { this.values.name = v.trim(); }));
    new Setting(contentEl).setName("Put it in").setDesc("Vault folder. Blank for the root.")
      .addText((t) => t.setPlaceholder("Lists").onChange((v) => { this.values.parent = v.trim(); }));
    new Setting(contentEl).setName("Minimum stars")
      .setDesc("With the age limit below, sets [pass:: yes] on entries that clear both.")
      .addText((t) => t.setPlaceholder("100").onChange((v) => { this.values.minStars = v.trim(); }));
    new Setting(contentEl).setName("Maximum days since last push")
      .addText((t) => t.setPlaceholder("92").onChange((v) => { this.values.maxAgeDays = v.trim(); }));
    new Setting(contentEl).setName("Include entries with no repo")
      .setDesc("Closed-source apps, sites, anything not on GitHub.")
      .addToggle((t) => t.onChange((v) => { this.values.includeNonRepo = v; }));
    new Setting(contentEl).setName("Project expectations")
      .addDropdown((d) => d.addOptions({ software: "Software", reference: "Reference list / complete resource" })
        .onChange((v) => { this.values.expectation = v; }));
    new Setting(contentEl).setName("Security advisories")
      .setDesc("Fetch published advisories and affected/patched versions. Each page uses the shared request budget.")
      .addToggle((t) => t.onChange((v) => { this.values.advisories = v; }));
    new Setting(contentEl).setName("Peer lists")
      .setDesc("Comma-separated owner/repo. Records which other lists carry each entry.")
      .addTextArea((t) => t.onChange((v) => { this.values.peers = v.trim(); }));
    new Setting(contentEl).setName("Markdown file")
      .setDesc("Only if the list is not in README.md. Filled in automatically from a /blob/ link.")
      .addText((t) => t.setPlaceholder("docs/list.md")
        .onChange((v) => { this.values.readmePath = v.trim(); }));
    new Setting(contentEl).setName("Limit").setDesc("Stop after N entries, to try a list out.")
      .addText((t) => t.onChange((v) => { this.values.limit = v.trim(); }));

    new Setting(contentEl).addButton((b) => b.setButtonText("Build it").setCta().onClick(async () => {
      if (!this.values.source) { new Notice("A repository is needed.", 4000); return; }
      const peers = {};
      for (const p of this.values.peers.split(",").map((x) => x.trim()).filter(Boolean)) {
        try {
          const { source } = parseSource(p);
          peers[source] = source.split("/")[1];
        } catch (err) { /* skip anything unparseable */ }
      }
      this.close();
      try {
        await this.plugin.initList({
          source: this.values.source,
          name: this.values.name || null,
          parent: this.values.parent || null,
          minStars: this.values.minStars ? parseInt(this.values.minStars, 10) : null,
          maxAgeDays: this.values.maxAgeDays ? parseInt(this.values.maxAgeDays, 10) : null,
          includeNonRepo: this.values.includeNonRepo,
          advisories: this.values.advisories,
          expectation: this.values.expectation,
          readmePath: this.values.readmePath || null,
          peers,
          limit: this.values.limit ? parseInt(this.values.limit, 10) : null,
        });
      } catch (err) {
        new Notice(`Could not build it: ${err.message}`, 8000);
        console.error(err);
      }
    }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ConvertModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.values = { folder: "", source: "", minStars: "", maxAgeDays: "", peers: "" };
    this.trashNotes = false;
  }

  /** Folders of one-note-per-entry notes, each with a repo in its frontmatter. */
  legacyFolders() {
    const counts = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter;
      if (!fm || !fm.repo || !file.parent) continue;
      counts.set(file.parent.path, (counts.get(file.parent.path) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Convert a folder of notes into a list" });
    const folders = this.legacyFolders();
    if (!folders.length) {
      contentEl.createEl("p", { text: "No folders of one-note-per-entry lists found." });
      return;
    }
    this.values.folder = folders[0][0];
    new Setting(contentEl).setName("Folder")
      .addDropdown((d) => {
        const opts = {};
        for (const [path, n] of folders) opts[path] = `${path} (${n} notes)`;
        d.addOptions(opts).setValue(this.values.folder)
          .onChange((v) => { this.values.folder = v; });
      });
    new Setting(contentEl).setName("Source list").setDesc("owner/repo the notes came from")
      .addText((t) => t.onChange((v) => { this.values.source = v.trim(); }));
    new Setting(contentEl).setName("Minimum stars").setDesc("Sets the [pass:: yes] field")
      .addText((t) => t.onChange((v) => { this.values.minStars = v.trim(); }));
    new Setting(contentEl).setName("Maximum days since last push")
      .addText((t) => t.onChange((v) => { this.values.maxAgeDays = v.trim(); }));
    new Setting(contentEl).setName("Peer lists").setDesc("Comma-separated owner/repo")
      .addTextArea((t) => t.onChange((v) => { this.values.peers = v.trim(); }));
    new Setting(contentEl).setName("Security advisories on later refreshes")
      .setDesc("One GitHub request per repo at about two a second, so a long list refreshes much slower.")
      .addToggle((t) => t.onChange((v) => { this.values.advisories = v; }));
    new Setting(contentEl).setName("Move converted notes to trash")
      .setDesc("Only supported repository fields and star history are copied; note bodies and " +
               "custom properties are not. Keep originals to compare them first. Other files stay in place.")
      .addToggle((t) => t.setValue(this.trashNotes).onChange((v) => { this.trashNotes = v; }));

    new Setting(contentEl).addButton((b) => b.setButtonText("Convert").setWarning()
      .onClick(async () => {
        if (!this.values.source) { new Notice("The source repo is needed.", 4000); return; }
        let source = this.values.source;
        try { source = parseSource(source).source; } catch (err) {
          new Notice("Expected owner/repo.", 4000);
          return;
        }
        const peers = {};
        for (const p of this.values.peers.split(",").map((x) => x.trim()).filter(Boolean)) {
          try { const { source: ps } = parseSource(p); peers[ps] = ps.split("/")[1]; }
          catch (err) { /* skip */ }
        }
        const label = this.values.folder.split("/").pop();
        this.close();
        await this.plugin.convertToOneNote({
          folder: this.values.folder, label, source, readmePath: "README.md",
          tag: slugify(label), tagPrefix: slugify(label),
          minStars: this.values.minStars ? parseInt(this.values.minStars, 10) : null,
          maxAgeDays: this.values.maxAgeDays ? parseInt(this.values.maxAgeDays, 10) : null,
          includeNonRepo: false, advisories: !!this.values.advisories, peers,
        }, this.trashNotes);
      }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class PickListModal extends SuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Which list?");
  }

  getSuggestions(query) {
    return this.plugin.loadConfigs()
      .filter((c) => c.label.toLowerCase().includes(query.toLowerCase()));
  }

  renderSuggestion(cfg, el) {
    el.createEl("div", { text: cfg.label });
    el.createEl("small", { text: cfg.source });
  }

  onChooseSuggestion(cfg) {
    this.plugin.run("all", cfg.tag);
  }
}

// ---------------------------------------------------------------- settings

class ListkeeperSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("GitHub token")
      .setDesc("Optional. Create a fine-grained token for public repository read access. No write permissions needed. Adds full activity fields and higher rate limits.")
      .addText((t) => { t.inputEl.type = "password"; t.setPlaceholder("github_pat_...").setValue(this.plugin.settings.token)
        .onChange(async (v) => { this.plugin.settings.token = v.trim(); await this.plugin.saveSettings(); }); });
    containerEl.createEl("a", { text: "Create a GitHub token", href: "https://github.com/settings/personal-access-tokens/new" });
    new Setting(containerEl).setName("Validate token").addButton((b) => b.setButtonText("Validate").onClick(async () => {
      new Notice(await this.plugin.validateToken(), 10000);
    }));

    new Setting(containerEl).setName("Schedule")
      .addDropdown((d) => d.addOptions({ off: "Off", daily: "Daily", weekly: "Weekly" })
        .setValue(this.plugin.settings.schedule)
        .onChange(async (v) => {
          this.plugin.settings.schedule = v;
          await this.plugin.saveSettings();
          new Notice("Reload Obsidian for the new schedule to take effect.", 5000);
        }));

    new Setting(containerEl).setName("What the schedule does")
      .addDropdown((d) => d.addOptions({
        refresh: "Refresh data only", sync: "Sync then refresh",
        crosslist: "Cross-list then refresh", all: "Sync, cross-list, refresh" })
        .setValue(this.plugin.settings.scheduleMode)
        .onChange(async (v) => { this.plugin.settings.scheduleMode = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Skip unless data is older than")
      .setDesc("Days. Stops a scheduled or startup run hitting GitHub when nothing is stale.")
      .addText((t) => t.setValue(String(this.plugin.settings.staleAfterDays))
        .onChange(async (v) => {
          this.plugin.settings.staleAfterDays = parseInt(v, 10) || 0;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName("Also run on startup")
      .addToggle((t) => t.setValue(this.plugin.settings.runOnStartup)
        .onChange(async (v) => { this.plugin.settings.runOnStartup = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Requests per run without a token")
      .setDesc("Shared across repository, star-history and advisory-page requests. Unattempted work goes first, then least recently attempted, across every list. GitHub response limits also apply.")
      .addText((t) => t.setValue(String(this.plugin.settings.noTokenBudget))
        .onChange(async (v) => {
          this.plugin.settings.noTokenBudget = parseInt(v, 10) || 55;
          await this.plugin.saveSettings();
        }));

    const lists = this.plugin.loadConfigs();
    new Setting(containerEl).setName("Lists managed").setHeading().setDesc(
      lists.length ? "Choose project expectations and optional advisory checks for each list."
                   : "None yet. Use the \"Add a list from GitHub\" command.")
      .addButton((b) => b.setButtonText("Refresh now").onClick(() => this.plugin.run("all")));
    for (const c of lists) {
      new Setting(containerEl).setName(`${c.label}: project expectations`)
        .addDropdown((d) => d.addOptions({ software: "Software", reference: "Reference list / complete resource" })
          .setValue(c.expectation || "software").onChange(async (v) => {
            c.expectation = v; await this.plugin.rememberList(c);
          }));
      new Setting(containerEl).setName(c.label).setDesc(`${c.source}, advisories`)
        .addToggle((t) => t.setValue(!!c.advisories).onChange(async (v) => {
          c.advisories = v;
          await this.plugin.rememberList(c);
        }));
    }
  }
}
