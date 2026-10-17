// Smoke test for listkeeper main.js against a stubbed Obsidian API.
// Run from this folder: node smoke.js        (or: node smoke.js path/to/main.js)
const path = require("path");
const Module = require("module");
const assert = require("assert");

const MAIN = path.resolve(process.argv[2] || path.join(__dirname, "..", "main.js"));

// minimal moment: only the calls main.js makes
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function moment(s) {
  const d = s ? new Date(String(s)) : new Date();
  return { _d: d, format: (f) => (f === "YYYY-MM-DD" ? ymd(d) : d.toISOString()),
           diff: (o) => Math.round((d - o._d) / 864e5) };
}
global.window = { moment, setInterval: () => 0 };

// canned GitHub
let README = [
  "# Awesome Things", "", "## Tools", "",
  "- [alpha](https://github.com/acme/alpha) - First tool",
  "- [beta](https://github.com/acme/beta) — Second tool", "",
  "## Sites", "", "- [gamma](https://gamma.example.com) - Not on GitHub", "",
  "## Ranked", "", "| # | Project | Stars | Description | OSS |", "|---|---|---|---|---|",
  '| 1 | <a name="delta"></a>[**delta**](https://github.com/acme/delta) | [1k](https://github.com/acme/delta/stargazers) | Fourth tool, from a table | ✅ |', "",
].join("\n");
const REPOS = {
  "acme/alpha": { stars: 120, closed: 3, touched: 5, prs: 2, merged: 4, contributors: 12, commits: 40, policy: true },
  "acme/beta": { stars: 7, closed: 0, touched: 0, prs: 0, merged: 0, contributors: 1, commits: 0, policy: false },
  "acme/delta": { stars: 1000, closed: 9, touched: 4, prs: 1, merged: 2, contributors: 5, commits: 12, policy: false },
};
// pages of advisories per repo; the stub links page n to page n+1 the way GitHub's cursor paging does
const ADVISORIES = { "acme/alpha": [
  [{ ghsa_id: "GHSA-aaaa", cve_id: "CVE-2026-0001", severity: "critical", state: "published" },
   { ghsa_id: "GHSA-bbbb", cve_id: null, severity: "low", state: "draft" }],
  [{ ghsa_id: "GHSA-cccc", cve_id: "CVE-2026-0002", severity: "high", state: "published" }],
] };
let gqlCalls = 0, advCalls = 0, historyCalls = 0;
const requests = [];
let intercept;
const weeks = [0, 1, 2, 3, 4, 5].map((n) => ({ week: Math.floor((Date.now() - (n * 7 + 2) * 864e5) / 1000), total: n + 1, days: [] }));
async function requestUrl(req) {
  requests.push(req);
  if (intercept) { const response = await intercept(req); if (response) return response; }
  if (req.url === "https://api.github.com/rate_limit") return { status: 200, json: { resources: { core: { remaining: 4999 }, graphql: { remaining: 4998 } } } };
  if (req.url.endsWith("/stargazers/history?per_page=6")) {
    historyCalls++;
    return { status: 200, json: weeks };
  }
  const rest = /^https:\/\/api.github.com\/repos\/([^/]+\/[^/]+)$/.exec(req.url);
  if (rest) {
    const r = REPOS[rest[1]];
    return r ? { status: 200, json: { full_name: rest[1], stargazers_count: r.stars,
      pushed_at: "2026-09-01T00:00:00Z", archived: false, created_at: "2020-01-01T00:00:00Z", license: { spdx_id: "MIT" } } }
      : { status: 404 };
  }
  if (req.url === "https://raw.githubusercontent.com/acme/awesome-things/main/README.md")
    return { status: 200, text: README };
  if (req.url === "https://api.github.com/graphql") {
    gqlCalls++;
    const asked = [...JSON.parse(req.body).query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)];
    // more than two repos in one query trips this stub's resource limit, as GitHub's does at scale
    if (asked.length > 2) return { status: 200, json: { errors: [{ message: "Resource limits for this query exceeded." }], data: {} } };
    const data = {};
    for (const m of asked) {
      const slug = `${m[2]}/${m[3]}`;
      const r = REPOS[slug];
      data[m[1]] = r ? {
        nameWithOwner: slug, stargazerCount: r.stars, pushedAt: "2026-09-01T00:00:00Z",
        isArchived: false, createdAt: "2020-01-01T00:00:00Z", forkCount: 3,
        issues: { totalCount: 1 }, closed: { totalCount: r.closed }, touched: { totalCount: r.touched },
        prs: { totalCount: r.prs }, merged: { totalCount: r.merged }, closed90: { totalCount: r.closed },
        mentionableUsers: { totalCount: r.contributors }, isSecurityPolicyEnabled: r.policy,
        releases: { nodes: [{ publishedAt: "2026-08-01T00:00:00Z" }] },
        defaultBranchRef: { target: { recent: { totalCount: r.commits } } },
        primaryLanguage: { name: "Python" }, licenseInfo: { spdxId: "MIT" }, latestRelease: null,
        repositoryTopics: { nodes: [] }, readme: null } : null;
    }
    return { status: 200, json: { data } };
  }
  const adv = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/security-advisories\?(.*)$/.exec(req.url);
  if (adv) {
    advCalls++;
    const pages = ADVISORIES[adv[1]] || [[]];
    const n = parseInt((/after=(\d+)/.exec(adv[2]) || [0, 0])[1], 10);
    const headers = n + 1 < pages.length
      ? { Link: `<https://api.github.com/repos/${adv[1]}/security-advisories?per_page=100&after=${n + 1}>; rel="next"` }
      : {};
    return { status: 200, json: pages[n], headers };
  }
  return { status: 404, text: "" };
}

// stub obsidian + in-memory vault
class TFile {
  constructor(p) {
    this.path = p;
    this.parent = { path: p.split("/").slice(0, -1).join("/") };
  }
}
const files = new Map();
const folders = new Set();
const frontmatter = new Map();
const trashed = [];
const opened = [];
const app = {
  vault: {
    getAbstractFileByPath: (p) => (files.has(p) ? new TFile(p) : folders.has(p) ? { path: p } : null),
    createFolder: async (p) => { folders.add(p); },
    create: async (p, t) => {
      const dir = p.split("/").slice(0, -1).join("/");
      assert(!dir || folders.has(dir), `ENOENT: no folder ${dir} for ${p}`);
      assert(!files.has(p), `create over existing ${p}`);
      files.set(p, t); return new TFile(p);
    },
    read: async (f) => files.get(f.path),
    modify: async (f, t) => { files.set(f.path, t); },
    process: async (f, fn) => { files.set(f.path, fn(files.get(f.path))); },
    append: async (f, t) => { files.set(f.path, files.get(f.path) + t); },
    getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith(".md")).map((p) => new TFile(p)),
    trash: async (file) => {
      trashed.push(file.path);
      for (const p of files.keys()) {
        if (p === file.path || p.startsWith(`${file.path}/`)) files.delete(p);
      }
      folders.delete(file.path);
    },
    adapter: {
      read: async (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p); },
      write: async (p, t) => { files.set(p, t); }, exists: async () => true, mkdir: async () => {},
      append: async (p, t) => { files.set(p, (files.get(p) || "") + t); },
    },
  },
  workspace: { onLayoutReady: (f) => f(), getLeaf: () => ({ openFile: async (file) => { opened.push(file.path); } }) },
  metadataCache: {
    getFileCache: (file) => ({ frontmatter: frontmatter.get(file.path) }),
    getFirstLinkpathDest: (link, source) => {
      const candidates = [`${link}.md`, path.posix.normalize(`${path.posix.dirname(source)}/${link}.md`)];
      const found = candidates.find((p) => files.has(p));
      return found ? new TFile(found) : null;
    },
  },
  fileManager: { generateMarkdownLink: (file) => `[[${file.path.replace(/\.md$/, "")}|Research]]` },
};
const notices = [];
const obsidian = {
  Plugin: class {
    constructor(a, m) { this.app = a; this.manifest = m; }
    addStatusBarItem() { return { setText() {} }; }
    addRibbonIcon() {} addCommand() {} addSettingTab() {} registerInterval() {}
    registerMarkdownCodeBlockProcessor() {}
    async loadData() { return {}; } async saveData() {}
  },
  PluginSettingTab: class {}, Setting: class {}, Modal: class {}, SuggestModal: class {}, Menu: class {},
  MarkdownRenderChild: class {},
  Notice: class { constructor(msg) { notices.push(msg); } },
  requestUrl, TFile, normalizePath: (p) => p.replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  return req === "obsidian" ? "obsidian" : resolve.call(this, req, ...rest);
};
require.cache.obsidian = { id: "obsidian", filename: "obsidian", loaded: true, exports: obsidian };

(async () => {
  const Listkeeper = require(MAIN);
  const plugin = new Listkeeper(app, { id: "listkeeper", dir: ".obsidian/plugins/listkeeper" });
  await plugin.onload();
  plugin.settings.token = "test-token";

  // init: the path "Add a list from GitHub" takes
  await plugin.initList({ source: "https://github.com/acme/awesome-things", parent: "Lists",
    advisories: true, peers: {} });
  const note = files.get("Lists/entries/Awesome Things.md");
  assert(note, "entries note written into a folder that did not exist yet");
  const view = files.get("Lists/Awesome Things.md");
  assert(view && view.includes("\n```listkeeper\nfile: Lists/entries/Awesome Things.md\n```\n"),
    "view note holds the block naming the entries note");
  assert(!/^- \[/m.test(view) && view.includes("3 entries from"), "view note carries no bullets");
  assert(note.includes("- [alpha](https://github.com/acme/alpha) — First tool [name:: alpha] [url:: https://github.com/acme/alpha] [stars:: 120]"), note);
  assert(note.includes("## Tools") && !note.includes("gamma"), "non-repo entry skipped by default");
  assert(!note.includes("```listkeeper"), "entries note carries no table block");
  assert(!files.has("Lists/Awesome Things dashboard.md") && !files.has("Lists/Awesome Things log.md"),
    "only the two notes enter the vault");
  assert(note.includes("- [delta](https://github.com/acme/delta) — Fourth tool, from a table [name:: delta] [url:: https://github.com/acme/delta] [stars:: 1000]"),
    "table row with an index column before the link");
  const alpha = note.split("\n").find((l) => l.startsWith("- [alpha]"));
  for (const f of ["[closed:: 3]", "[touched:: 5]", "[prs:: 2]", "[commits:: 40]", "[openratio:: 0.25]",
                   "[perday:: ", "[policy:: yes]", "[advisories:: 2]", "[severity:: critical]", "[cve:: CVE-2026-0001]",
                   "[url:: https://github.com/acme/alpha]", "[merged:: 4]", "[contributors:: 12]",
                   "[engagement:: 58.3]", "[crit:: "]) {
    assert(alpha.includes(f), `alpha line carries ${f}: ${alpha}`);
  }
  const beta = note.split("\n").find((l) => l.startsWith("- [beta]"));
  assert(beta.includes("[commits:: 0]") && beta.includes("[openratio:: 1]")
    && beta.includes("[policy:: no]") && beta.includes("[advisories:: 0]"),
    `beta: zero commits kept, ratio 1 with nothing closed, no policy, no advisories: ${beta}`);
  // the table parser reads back what entryLine wrote
  const parsed = Listkeeper.parseEntries(note);
  assert.strictEqual(parsed.length, 3, "table parser sees every entry");
  const pa = parsed.find((r) => r.name === "alpha");
  assert(pa.stars === 120 && pa.advisories === 2 && pa.section === "Tools" && pa.desc === "First tool"
    && pa.url === "https://github.com/acme/alpha" && pa.openratio === 0.25, JSON.stringify(pa));
  assert(Listkeeper.PRESETS["Advisories, published CVEs"].test(pa)
    && !Listkeeper.PRESETS["Quiet, no commits in 90d"].test(pa)
    && Listkeeper.PRESETS["Quiet, no commits in 90d"].test(parsed.find((r) => r.name === "beta")),
    "presets pick the right rows");
  assert(pa.engagement === 58.3 && typeof pa.crit === "number" && pa.crit > 0 && pa.crit < 1.3,
    `derived columns: ${pa.engagement} ${pa.crit}`);
  // the verdict: one soft signal is caution, two make a check, a clean row is ok
  const judged = (name) => Listkeeper.verdict(parsed.find((r) => r.name === name), { lowEngagement: -1 });
  assert(judged("alpha").rank === 2 && judged("alpha").reasons.length === 2,
    `a disclosed advisory on an active project is not a signal: ${JSON.stringify(judged("alpha"))}`);
  assert(judged("beta").rank === 1 && !judged("beta").reasons.length,
    `beta verdict: ${JSON.stringify(judged("beta"))}`);
  assert(judged("delta").rank === 1 && !judged("delta").reasons.length, `delta verdict: ${JSON.stringify(judged("delta"))}`);
  const v = (row) => Listkeeper.verdict(row, { lowEngagement: -1 });
  const now = ymd(new Date());
  assert(v({ name: "x" }).rank === 0, "no activity data gives no verdict");
  assert(v({ pushed: "2020-01-01", commits: 0, lic: "MIT" }).rank === 1, "quiet alone does not require review");
  assert(v({ pushed: now, commits: 5, lic: "MIT", section: "⚰️ Graveyard" }).rank === 3, "the source's graveyard section is a hard signal");
  assert(v({ pushed: now, commits: 0, contributors: 1, created: now, lic: "MIT" }).rank === 1, "small and young do not imply unsuitable");
  assert(v({ pushed: now, commits: 0, contributors: 1, lic: "MIT" }).rank === 1, "quiet software may be complete");
  // filter terms: words, phrases, field terms, negation; unusable terms are dropped
  for (const r of parsed) r.verdict = Listkeeper.VERDICTS[Listkeeper.verdict(r, { lowEngagement: -1 }).rank];
  const terms = Listkeeper.parseTerms('stars>100 -lang:go "first tool" verdict:caution junk>x nothere:1');
  assert(terms.length === 6 && terms[1].neg && terms[2].value === "first tool" && terms[0].op === ">",
    JSON.stringify(terms));
  const usable = Listkeeper.usableTerms(terms, parsed);
  assert(usable.length === 4, `unknown field and bad number dropped: ${usable.length}`);
  const hits = parsed.filter((r) => Listkeeper.rowMatches(r, usable)).map((r) => r.name);
  assert(hits.join() === "alpha", `alpha alone matches the terms: ${hits}`);
  assert(Listkeeper.rowMatches(pa,Listkeeper.parseTerms("pushed>=2026-09-01 stars<=120")), "dates and <= compare");
  assert(!Listkeeper.rowMatches(pa,Listkeeper.parseTerms("-alpha")), "a negated word excludes");
  // multi-key sort: ties on the first key fall through to the second, blanks last on every key
  const sorted = Listkeeper.sortRows(parsed.slice(), [["lang", 1], ["stars", -1]]).map((r) => r.name);
  assert(sorted.join() === "delta,alpha,beta", `two-key sort: ${sorted}`);
  assert(Listkeeper.sortRows([{ a: 1 }, { b: 1 }, { a: 0 }], [["a", 1]]).map((r) => r.a).join() === "0,1,",
    "blank last");
  const keys = new Set(Listkeeper.COLUMNS.map((c) => c[0]));
  assert(Listkeeper.DEFAULT_COLUMNS.every((k) => keys.has(k)) && Listkeeper.DEFAULT_COLUMNS.length < keys.size / 2,
    "the default columns exist and are under half of all columns");
  const best = Listkeeper.PRESETS["Best bets, ok with high criticality"].test;
  const ok = Listkeeper.VERDICTS[1];
  assert(best({ verdict: ok, crit: 0.8 }) && !best({ verdict: ok, crit: 0.8, severity: "high" })
    && !best({ verdict: Listkeeper.VERDICTS[2], crit: 0.9 }) && !best({ verdict: ok, crit: 0.5 }),
    "best bets: ok verdict, criticality 0.7 or more, no high or critical advisory");
  const low = Listkeeper.PRESETS["Low engagement for its stars"];
  assert(low.test(Object.assign({}, pa, { stars: 5000 }), { lowEngagement: 100 })
    && !low.test(pa, { lowEngagement: 100 }), "low-engagement preset needs 1000+ stars");
  assert(files.get(".obsidian/plugins/listkeeper/data/awesome-things-log.txt").includes("init: 3 entries, 2 sections"),
    "run log lives in the plugin data folder");
  const hist = JSON.parse(files.get(".obsidian/plugins/listkeeper/data/awesome-things-history.json"));
  assert.strictEqual(hist.entries["acme/alpha"].length, 1, "history store");
  assert.strictEqual(plugin.settings.lists.length, 1, "list remembered in settings");
  assert.strictEqual(gqlCalls, 3, "each metadata task receives an attempt");

  // refresh: star count moves, entry line rebuilt in place
  REPOS["acme/alpha"].stars = 125;
  await plugin.run("refresh");
  assert(files.get("Lists/entries/Awesome Things.md").includes("[stars:: 125]"), "refresh rewrote the entry line");
  assert(plugin.loadConfigs()[0].advisories === true && advCalls > 0, "the list remembers that it fetches advisories");

  // advisories are opt-in: without the flag the REST endpoint is never called
  const before = advCalls;
  const noAdvisory = { ...plugin.loadConfigs()[0], advisories: false };
  await plugin.refreshMarkdown(noAdvisory);
  assert(advCalls === before, "no advisory request unless the list asks for them");

  // a note with table and bullets in one file is split on first sight
  const old = { label: "Old List", tag: "old-list", source: "acme/old-list", parent: "Lists" };
  files.set("Lists/Old List.md", "---\nlist: \"Old List\"\n---\n\n# Old List\n\n1 entry from [acme/old-list](https://github.com/acme/old-list).\n\n```listkeeper\n```\n\n## Tools\n\n- [alpha](https://github.com/acme/alpha) — First tool [stars:: 1]\n  - my own note\n");
  assert(await plugin.entriesFile(old), "split returns the entries note");
  assert(files.get("Lists/entries/Old List.md").includes("- [alpha](https://github.com/acme/alpha) — First tool [stars:: 1]\n  - my own note"),
    "bullets and sub-bullets moved to the entries note");
  const oldView = files.get("Lists/Old List.md");
  assert(oldView.includes("file: Lists/entries/Old List.md") && !oldView.includes("- [alpha]") && oldView.includes("1 entry from"),
    "view note rebuilt with the block only");
  // Conversion must not trash unrelated notes, attachments, or nested folders.
  const conversion = { folder: "Legacy", label: "Legacy", tag: "legacy", source: "acme/old-list" };
  folders.add("Legacy");
  folders.add("Legacy/nested");
  const originals = new Map([
    ["Legacy/project.md", "Original body and custom properties stay here."],
    ["Legacy/unrelated.md", "Unrelated note"],
    ["Legacy/attachment.png", "Attachment"],
    ["Legacy/nested/project.md", "Nested note"],
  ]);
  for (const [p, text] of originals) files.set(p, text);
  frontmatter.set("Legacy/project.md", {
    repo: "acme/alpha", app: "alpha", url: "https://github.com/acme/alpha", stars: 125,
    history: ["2026-09-01:120"],
  });
  frontmatter.set("Legacy/nested/project.md", { repo: "acme/beta" });

  await plugin.convertToOneNote(conversion, false);
  assert.strictEqual(trashed.length, 0, "keeping originals never calls trash");
  for (const [p, text] of originals) assert.strictEqual(files.get(p), text, `original preserved: ${p}`);
  assert(files.get("Legacy.md").includes("file: entries/Legacy.md"), "converted view is usable");
  assert(files.get("entries/Legacy.md").includes("[stars:: 125]"), "supported fields converted");
  assert.deepStrictEqual(JSON.parse(files.get(".obsidian/plugins/listkeeper/data/legacy-history.json"))
    .entries["acme/alpha"], ["2026-09-01:120"], "history preserved before trash");

  const writeListNote = plugin.writeListNote;
  plugin.writeListNote = async () => { throw new Error("write failed"); };
  await assert.rejects(plugin.convertToOneNote(conversion, true), /write failed/);
  plugin.writeListNote = writeListNote;
  assert.strictEqual(trashed.length, 0, "a failed conversion never trashes originals");

  await plugin.convertToOneNote(conversion, true);
  assert.deepStrictEqual(trashed, ["Legacy/project.md"], "only the converted direct child is trashed");
  for (const [p, text] of originals) {
    if (p !== "Legacy/project.md") assert.strictEqual(files.get(p), text, `unrelated file preserved: ${p}`);
  }
  assert(folders.has("Legacy") && folders.has("Legacy/nested"), "source and nested folders remain");
  const fixture = (tag, extra = {}) => ({ label: tag, tag, source: "acme/awesome-things", parent: "Fixtures", ...extra });
  const entry = (repo, desc = "Original", section = "Tools") => ({ repo, name: repo.split("/")[1], url: `https://github.com/${repo}`, desc, section });
  const currentRows = (cfg) => Listkeeper.parseEntries(files.get(plugin.entriesPath(cfg)));
  const saveRows = async (cfg, entries) => {
    await plugin.writeListNote(cfg, entries.map((e) => plugin.storeRow(cfg, e)));
    await plugin.rememberList(cfg);
  };

  const boundary = Date.parse("2026-10-03T05:30:00Z");
  const apiWeeks = [0, 1, 2, 3, 4, 5].map((n) => ({ week: (boundary - n * 7 * 864e5) / 1000, total: n + 1 }));
  const additions = Listkeeper.starWeeks(apiWeeks, boundary + 2 * 864e5);
  assert.strictEqual(additions.additions, 14, "exclude incomplete current bucket; count the four completed API weeks");
  assert.strictEqual(additions.start, "2026-09-05T05:30:00.000Z", "retain API boundary time without UTC calendar-week rounding");
  assert.strictEqual(additions.end, "2026-10-03T05:30:00.000Z");
  assert.strictEqual(Listkeeper.starWeeks(apiWeeks.slice(0, 3), boundary), null, "less than four complete weeks is unavailable");
  const actualShape = [{ week: 1790467200, total: 74, days: [12, 9, 7, 13, 11, 17, 5] },
    { week: 1789862400, total: 95 }, { week: 1789257600, total: 88 }, { week: 1788652800, total: 70 }];
  assert.strictEqual(Listkeeper.starWeeks(actualShape, 1791072000000).additions, 327, "real API Unix-second week shape");
  assert.strictEqual(v({ archived: "yes" }).rank, 3, "archive evidence survives missing activity");
  assert.strictEqual(Listkeeper.verdict({ pushed: "2020-01-01", commits: 0, issues: 100, touched: 0 }, { expectation: "reference" }).rank, 1,
    "reference lists do not receive software tracker or cadence concerns");

  const reviewed = fixture("reviewed", { advisories: true });
  await saveRows(reviewed, [entry("acme/alpha")]);
  await plugin.refreshMarkdown(reviewed);
  let rr = currentRows(reviewed)[0];
  assert.strictEqual(rr.state.history.additions, 14, "star additions available immediately");
  assert.strictEqual(rr.gained, undefined, "API additions do not manufacture local net change");
  const hc = historyCalls;
  await plugin.refreshMarkdown(reviewed);
  assert.strictEqual(historyCalls, hc, "successful history is cached for 24 hours");
  await plugin.reviewEntry(reviewed, "acme/alpha", "suitable", "Suitable for our pinned package version");
  rr = Listkeeper.decorateRow(currentRows(reviewed)[0], reviewed);
  assert.strictEqual(rr.newfindings, 0, "assessment acknowledges current advisory identities");
  REPOS["acme/alpha"].stars++;
  await plugin.refreshMarkdown(reviewed);
  rr = Listkeeper.decorateRow(currentRows(reviewed)[0], reviewed);
  assert.strictEqual(rr.newfindings, 0, "star and check-date changes do not invalidate assessment");
  assert.strictEqual(rr.state.review.reason, "Suitable for our pinned package version");
  ADVISORIES["acme/alpha"][0][0].vulnerabilities = [{ package: { name: "alpha", ecosystem: "npm" }, vulnerable_version_range: "<2.0", patched_versions: "2.0" }];
  await plugin.refreshMarkdown(reviewed);
  rr = Listkeeper.decorateRow(currentRows(reviewed)[0], reviewed);
  assert.strictEqual(rr.newfindings, 1, "material affected/patched version changes request another review");
  assert.strictEqual(rr.state.advisory.items[0].versions[0].patched, "2.0");
  assert.strictEqual(rr.verdict, Listkeeper.VERDICTS[2], "historical advisory is review context, not a claim of current vulnerability");

  const beforeFailure = currentRows(reviewed)[0];
  intercept = async (req) => req.url.endsWith("/graphql") ? { status: 502, json: {} } : undefined;
  await plugin.refreshMarkdown(reviewed);
  intercept = null;
  rr = currentRows(reviewed)[0];
  assert.strictEqual(rr.stars, beforeFailure.stars, "failed metadata preserves last known fields");
  assert.strictEqual(rr.state.metadata.checked, beforeFailure.state.metadata.checked, "failed metadata retains last successful timestamp");
  assert.strictEqual(rr.state.metadata.status, "failed");
  assert.strictEqual(plugin.loadConfigs().find((c) => c.tag === reviewed.tag).cycle, reviewed.cycle,
    "failed metadata leaves an incomplete cycle eligible for scheduled work");
  assert(Listkeeper.decorateRow(rr, reviewed).coverage.includes("failed"));
  assert(Listkeeper.decorateRow(rr, { ...reviewed, advisories: false }).coverage.includes("disabled"));

  intercept = async (req) => req.url.endsWith("/graphql") ? { status: 200, json: { data: {
    r0: { nameWithOwner: "acme/alpha", stargazerCount: 140 },
  } } } : undefined;
  await plugin.refreshMarkdown(reviewed);
  intercept = null;
  rr = currentRows(reviewed)[0];
  assert.strictEqual(rr.policy, "yes", "unavailable security-policy field retains last known value");
  assert.strictEqual(rr.pushed, beforeFailure.pushed, "unavailable activity field retains last known value");
  assert.strictEqual(rr.state.metadata.retained.security_policy, beforeFailure.state.metadata.checked,
    "retained fields keep the date of their actual evidence");
  let historyEntry = (await plugin.readListNote(reviewed)).entries[0];
  const storedAdditions = historyEntry.row.state.history.additions;
  await plugin.writeListNote(reviewed, [{ ...historyEntry.row, update: (row) => {
    row.state.history.checked = "2020-01-01T00:00:00Z"; return row;
  } }]);
  intercept = async (req) => req.url.includes("/stargazers/history") ? { status: 404 } : undefined;
  await plugin.refreshMarkdown(reviewed);
  intercept = null;
  rr = currentRows(reviewed)[0];
  assert.strictEqual(rr.state.history.status, "failed");
  assert.strictEqual(rr.state.history.additions, storedAdditions, "history failure retains stale additions");
  assert.strictEqual(rr.state.metadata.status, "ok", "history failure does not fail repository metadata");
  assert(Listkeeper.decorateRow(rr, reviewed).historycoverage.includes("stale"));

  const evidenceFixture = fixture("explicit-evidence");
  await saveRows(evidenceFixture, [entry("acme/alpha", "A dead simple archive extraction utility")]);
  assert.strictEqual(currentRows(evidenceFixture)[0].state.source.evidence, "", "ordinary archive/dead prose is not deprecation evidence");
  await plugin.syncMarkdown(evidenceFixture, [entry("acme/alpha", "This project is deprecated")]);
  assert.strictEqual(Listkeeper.verdict(currentRows(evidenceFixture)[0]).rank, 3, "explicit source deprecation remains visible");

  const displayedFindings = Listkeeper.findings(currentRows(reviewed)[0], reviewed).map((f) => f.id);
  const duringReview = (await plugin.readListNote(reviewed)).entries[0];
  await plugin.writeListNote(reviewed, [{ ...duringReview.row, update: (row) => {
    row.state.advisory.items.push({ id: "GHSA-new-during-review", severity: "critical", versions: [] });
    return row;
  } }]);
  await plugin.reviewEntry(reviewed, "acme/alpha", "reviewed", "Only the findings I saw", displayedFindings);
  assert.strictEqual(Listkeeper.decorateRow(currentRows(reviewed)[0], reviewed).newfindings, 1,
    "saving an open assessment does not acknowledge findings fetched after the displayed snapshot");

  const sync = fixture("source-sync");
  await saveRows(sync, [entry("acme/alpha")]);
  const syncPath = plugin.entriesPath(sync);
  files.set(syncPath, files.get(syncPath).replace(" [name::", " [custom-field:: keep] [name::") + "\n  - [[Unrelated]]\n\n  - personal note\n\nSurrounding prose.\n");
  await plugin.syncMarkdown(sync, [entry("acme/alpha", "Upstream two", "New section")]);
  assert.strictEqual(currentRows(sync)[0].desc, "Upstream two", "untouched description follows upstream");
  assert.strictEqual(currentRows(sync)[0].section, "New section", "untouched section follows upstream");
  assert(files.get(syncPath).includes("[custom-field:: keep]"), "unrecognized inline fields survive reconstruction");
  assert(files.get(syncPath).indexOf("## New section") < files.get(syncPath).indexOf("  - personal note"), "attached notes move with entry");
  assert(files.get(syncPath).includes("Surrounding prose."), "section movement preserves prose");
  files.set(syncPath, files.get(syncPath).replace("— Upstream two", "— Local [description]").replace("## New section", "## My section"));
  await plugin.syncMarkdown(sync, [entry("acme/alpha", "Upstream three", "Third section")]);
  let sr = currentRows(sync)[0];
  assert.strictEqual(sr.desc, "Local [description]", "local edited description with brackets survives");
  assert.strictEqual(sr.section, "My section");
  assert.deepStrictEqual(sr.state.source.conflicts, { description: "Upstream three", section: "Third section" });
  await plugin.resolveSource(sync, "acme/alpha", "description", true, "Earlier incoming description");
  assert.strictEqual(currentRows(sync)[0].desc, "Local [description]", "stale conflict acceptance preserves local content");
  assert.strictEqual(currentRows(sync)[0].state.source.conflicts.description, "Upstream three", "stale conflict action preserves newer pending source change");
  await plugin.resolveSource(sync, "acme/alpha", "description", false, "Earlier incoming description");
  assert.strictEqual(currentRows(sync)[0].state.source.conflicts.description, "Upstream three", "stale dismiss cannot acknowledge an unseen value");
  await plugin.resolveSource(sync, "acme/alpha", "description", false);
  await plugin.resolveSource(sync, "acme/alpha", "section", true);
  await plugin.syncMarkdown(sync, [entry("acme/alpha", "Upstream three", "Third section")]);
  sr = currentRows(sync)[0];
  assert.strictEqual(sr.desc, "Local [description]", "dismiss keeps the local value");
  assert.strictEqual(sr.section, "Third section", "accept applies just the selected field");
  assert.deepStrictEqual(sr.state.source.conflicts, {}, "accepted and dismissed values do not repeat");
  await plugin.syncMarkdown(sync, [entry("acme/alpha", "Upstream four", "Fourth section")]);
  sr = currentRows(sync)[0];
  assert.strictEqual(sr.state.source.conflicts.description, "Upstream four", "later upstream changes can conflict again");
  assert.strictEqual(sr.section, "Fourth section", "independent accepted section continues following upstream");
  await plugin.syncMarkdown(sync, []);
  assert.strictEqual(currentRows(sync)[0].delisted, "yes");
  await plugin.syncMarkdown(sync, [entry("acme/alpha", "Upstream four", "Fourth section")]);
  assert.strictEqual(currentRows(sync)[0].delisted, undefined, "source reappearance clears removal state");
  const savedSource = files.get(syncPath);
  intercept = async (req) => req.url.startsWith("https://raw.githubusercontent.com/") ? { status: 404, text: "" } : undefined;
  await plugin.syncList(sync);
  intercept = null;
  assert.strictEqual(files.get(syncPath), savedSource, "failed source reads preserve the entire note and source baselines");

  const legacy = fixture("legacy-baseline");
  await saveRows(legacy, [entry("acme/beta", "Local legacy", "Personal")]);
  files.set(plugin.entriesPath(legacy), files.get(plugin.entriesPath(legacy)).replace(/ \[lk:: [^\]]+\]/g, ""));
  await plugin.syncMarkdown(legacy, [entry("acme/beta", "First upstream", "Upstream")]);
  let lr = currentRows(legacy)[0];
  assert.strictEqual(lr.desc, "Local legacy");
  assert.strictEqual(lr.section, "Personal");
  assert.deepStrictEqual(lr.state.source.conflicts, { description: "First upstream", section: "Upstream" }, "legacy values preserved on first observation");
  await plugin.resolveSource(legacy, "acme/beta", "description", false);
  await plugin.syncMarkdown(legacy, [entry("acme/beta", "First upstream", "Upstream")]);
  assert.strictEqual(currentRows(legacy)[0].state.source.conflicts.description, undefined);

  const rename = fixture("rename");
  await saveRows(rename, [entry("acme/alpha")]);
  await plugin.reviewEntry(rename, "acme/alpha", "reviewed", "Keep my review");
  files.set(plugin.entriesPath(rename), files.get(plugin.entriesPath(rename)) + "  - preserved note\n");
  intercept = async (req) => {
    if (!req.url.endsWith("/graphql")) return;
    files.set(plugin.entriesPath(rename), files.get(plugin.entriesPath(rename)).replace("— Original", "— Edit while fetching"));
    return { status: 200, json: { data: { r0: { nameWithOwner: "new-owner/renamed", stargazerCount: 321, isArchived: true } } } };
  };
  await plugin.refreshMarkdown(rename);
  intercept = null;
  await plugin.syncMarkdown(rename, [entry("acme/alpha")]);
  const renamed = currentRows(rename);
  assert.strictEqual(renamed.length, 1, "canonical rename then original source identity does not duplicate");
  assert.strictEqual(renamed[0].url, "https://github.com/new-owner/renamed");
  assert.strictEqual(renamed[0].desc, "Edit while fetching", "network results merge against current local description");
  assert.strictEqual(renamed[0].delisted, undefined, "canonical rename is not source removal");
  assert.strictEqual(renamed[0].state.review.reason, "Keep my review");
  assert(files.get(plugin.entriesPath(rename)).includes("  - preserved note"));
  assert.strictEqual(Listkeeper.verdict(renamed[0]).rank, 3, "partial metadata does not hide archived state");

  folders.add("Fixtures/research");
  files.set("Fixtures/research/new-owner--renamed.md", "Unrelated collision");
  await plugin.openResearch(rename, "new-owner/renamed");
  const researchPath = opened.at(-1);
  assert.strictEqual(researchPath, "Fixtures/research/new-owner--renamed 2.md", "research collisions get a new safe destination");
  assert.strictEqual(files.get("Fixtures/research/new-owner--renamed.md"), "Unrelated collision");
  assert.strictEqual(files.get(researchPath), "# Research\n\n[new-owner/renamed](https://github.com/new-owner/renamed)\n", "research note has no duplicate fetched metadata");
  const afterResearch = files.size;
  await plugin.openResearch(rename, "acme/alpha");
  assert.strictEqual(files.size, afterResearch, "source alias reuses the explicit attached note");
  const renamePath = plugin.entriesPath(rename);
  files.set(renamePath, files.get(renamePath).replace(/  - Research: \[\[[^\]]+\]\]/,
    "\n  - [[Unrelated]]\n\n  - Research: [[../research/new-owner--renamed 2|My notes]]"));
  files.set(researchPath, "My existing research is untouched");
  const reload = new Listkeeper(app, plugin.manifest);
  await reload.onload();
  reload.settings = JSON.parse(JSON.stringify(plugin.settings));
  await reload.openResearch(rename, "new-owner/renamed");
  assert.strictEqual(opened.at(-1), researchPath, "relative aliased research links resolve after reload; unrelated first wikilink ignored");
  assert.strictEqual(files.get(researchPath), "My existing research is untouched");

  const paged = fixture("paged", { advisories: true });
  await saveRows(paged, [entry("acme/alpha")]);
  let pe = (await plugin.readListNote(paged)).entries[0];
  await plugin.writeListNote(paged, [{ ...pe.row, update: (row) => {
    row.state.advisory = { status: "ok", checked: "2020-01-01T00:00:00Z", items: [{ id: "GHSA-old", severity: "high", versions: [] }] };
    return row;
  } }]);
  pe = (await plugin.readListNote(paged)).entries[0];
  await plugin.enrich({ cfg: paged, e: pe, kind: "advisory" }, { left: 1 });
  let ar = currentRows(paged)[0].state.advisory;
  assert.strictEqual(ar.status, "partial");
  assert(ar.items.some((a) => a.id === "GHSA-old") && ar.items.some((a) => a.id === "GHSA-aaaa"), "partial pagination retains old plus new findings");
  assert.strictEqual(ar.checked, "2020-01-01T00:00:00Z");
  intercept = async (req) => req.url.includes("security-advisories") ? { status: 500 } : undefined;
  pe = (await plugin.readListNote(paged)).entries[0];
  await plugin.enrich({ cfg: paged, e: pe, kind: "advisory" }, { left: 1 });
  intercept = null;
  assert.strictEqual(currentRows(paged)[0].state.advisory.status, "partial", "interrupted pagination stays partial");
  pe = (await plugin.readListNote(paged)).entries[0];
  await plugin.enrich({ cfg: paged, e: pe, kind: "advisory" }, { left: 1 });
  ar = currentRows(paged)[0].state.advisory;
  assert.strictEqual(ar.status, "ok");
  assert(!ar.items.some((a) => a.id === "GHSA-old"), "only a completed fresh scan replaces old advisory findings");

  plugin.settings.lists = [];
  plugin.settings.token = "";
  plugin.settings.noTokenBudget = 1;
  const beforeImport = requests.length;
  await plugin.initList({ source: "acme/awesome-things", name: "Complete import", parent: "Fixtures", limit: 3 });
  const complete = plugin.loadConfigs()[0];
  assert.strictEqual(currentRows(complete).length, 2, "limit applies to parsed entries; disabled ordinary external links are omitted");
  assert.strictEqual(requests.slice(beforeImport).filter((r) => r.url.startsWith("https://api.github.com/")).length, 1,
    "metadata and history share the import allowance");
  assert(complete.cycle && !complete.lastRefresh, "incomplete initial import is not marked fresh");
  await plugin.initList({ source: "acme/awesome-things", name: "All entries", tag: "all-entries", parent: "Fixtures" });
  const all = plugin.loadConfigs().find((c) => c.tag === "all-entries");
  assert.strictEqual(currentRows(all).length, 3, "all GitHub entries import despite budget one");
  assert(currentRows(all).some((r) => !r.state.metadata), "unvisited entries remain pending, not failed");

  intercept = async (req) => req.url.startsWith("https://raw.githubusercontent.com/acme/peer/")
    ? { status: 200, text: "- [beta](https://github.com/acme/beta)" } : undefined;
  await plugin.initList({ source: "acme/awesome-things", name: "Peer import", tag: "peer-import", parent: "Fixtures", peers: { "acme/peer": "Peer" } });
  intercept = null;
  const peerImport = plugin.loadConfigs().find((c) => c.tag === "peer-import");
  const peerBeta = currentRows(peerImport).find((r) => r.name === "beta");
  assert.strictEqual(peerBeta.lists, 2, "initial peer membership survives pending metadata outside the budget");
  assert.strictEqual(peerBeta.state.metadata, undefined);

  plugin.settings.lists = [];
  const first = fixture("first-fair"), second = fixture("second-fair");
  await saveRows(first, [entry("acme/missing"), entry("acme/alpha")]);
  await saveRows(second, [entry("acme/beta"), entry("acme/delta")]);
  let fair = plugin;
  for (let i = 0; i < 12; i++) {
    const before = requests.length;
    await fair.run("refresh", null, 7);
    assert(requests.length - before <= 1, "one shared API request per run across lists and enrichment types");
    const next = new Listkeeper(app, plugin.manifest);
    await next.onload();
    next.settings = JSON.parse(JSON.stringify(fair.settings));
    fair = next;
  }
  for (const cfg of [first, second]) {
    for (const row of currentRows(cfg)) assert(row.state.metadata?.attempted, `budget-one persisted fairness reached ${row.name}`);
  }
  assert.strictEqual(currentRows(first).find((r) => r.name === "missing").state.metadata.status, "failed");
  assert(currentRows(second).every((r) => r.state.metadata.checked && r.state.history.checked), "later list completes despite failing first entry");
  REPOS["acme/missing"] = { stars: 2 };
  for (let i = 0; i < 5; i++) await fair.run("refresh", null, 7);
  assert.strictEqual(currentRows(first).find((r) => r.name === "missing").state.metadata.status, "ok", "failed entry can recover on a later attempt");

  const stalled = fixture("stalled-siblings");
  plugin.settings.noTokenBudget = 20;
  await saveRows(stalled, [entry("acme/alpha"), entry("acme/never-exists")]);
  await plugin.refreshMarkdown(stalled);
  assert(stalled.cycle, "permanent metadata failure keeps the cycle incomplete");
  const oldStars = REPOS["acme/alpha"].stars;
  REPOS["acme/alpha"].stars = oldStars + 100;
  await plugin.refreshMarkdown(stalled);
  assert.strictEqual(currentRows(stalled).find((r) => r.name === "alpha").stars, oldStars + 100,
    "manual refresh updates successful siblings despite a permanently missing repository");
  const staleSibling = (await plugin.readListNote(stalled)).entries.find((e) => e.repo === "acme/alpha");
  await plugin.writeListNote(stalled, [{ ...staleSibling.row, update: (row) => {
    row.state.metadata.checked = "2020-01-01T00:00:00Z"; return row;
  } }]);
  REPOS["acme/alpha"].stars++;
  plugin.settings.lists = [{ ...stalled }];
  await plugin.run("refresh", null, 7);
  assert.strictEqual(currentRows(stalled).find((r) => r.name === "alpha").stars, oldStars + 101,
    "scheduled due metadata updates even while another entry keeps its list incomplete");
  const young = fixture("incomplete-history");
  await saveRows(young, [entry("acme/beta")]);
  intercept = async (req) => req.url.includes("/stargazers/history") ? { status: 200, json: weeks.slice(0, 2) } : undefined;
  await plugin.refreshMarkdown(young);
  REPOS["acme/beta"].stars = 19;
  await plugin.refreshMarkdown(young);
  intercept = null;
  assert.strictEqual(currentRows(young)[0].stars, 19, "insufficient API history does not freeze later metadata refreshes");

  plugin.settings.lists = [];
  const rateFirst = fixture("rate-first"), rateSecond = fixture("rate-second");
  await saveRows(rateFirst, [entry("acme/alpha")]);
  await saveRows(rateSecond, [entry("acme/beta")]);
  plugin.settings.noTokenBudget = 20;
  intercept = async (req) => req.url.includes("api.github.com/repos/") ? { status: 200,
    headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600) },
    json: { full_name: "acme/alpha", stargazers_count: 999 } } : undefined;
  const rateStart = requests.length;
  await plugin.run("refresh");
  intercept = null;
  assert.strictEqual(requests.length - rateStart, 1, "remaining=0 pauses all lists and enrichment requests");
  assert.strictEqual(currentRows(rateFirst)[0].stars, 999, "last allowed successful response is retained");
  assert.strictEqual(currentRows(rateSecond)[0].state.metadata, undefined, "rate pause does not mark unvisited entries failed");
  assert(plugin.settings.rateReset > Date.now(), "server reset persisted across reload");
  plugin.settings.rateReset = 0;
  plugin.settings.lists = [];
  const rejectedRate = fixture("rate-rejected");
  await saveRows(rejectedRate, [entry("acme/alpha"), entry("acme/beta")]);
  intercept = async (req) => req.url.startsWith("https://api.github.com/") ? { status: 403,
    headers: { "x-ratelimit-remaining": "0", "retry-after": "60" } } : undefined;
  await plugin.run("refresh");
  intercept = null;
  const rejectedRows = currentRows(rejectedRate);
  assert.strictEqual(rejectedRows[0].state.metadata.status, "pending", "rate-limited attempt stays pending rather than failed");
  assert(rejectedRows[0].state.metadata.attempted, "rate-limited attempt is persisted");
  assert.strictEqual(rejectedRows[1].state.metadata, undefined, "unvisited entry untouched after rate rejection");
  plugin.settings.rateReset = 0;
  plugin.settings.token = "never-print-this-token";
  assert((await plugin.validateToken()).includes("Token accepted"));
  intercept = async (req) => req.url.endsWith("/rate_limit") ? { status: 401 } : undefined;
  assert.strictEqual(await plugin.validateToken(), "GitHub rejected this token.");
  intercept = null;
  assert(!notices.some((n) => n.includes("never-print-this-token")), "token never appears in notices");
  assert(requests.filter((req) => req.headers?.Authorization).every((req) => req.url.startsWith("https://api.github.com/")), "credentials go only to the GitHub API host");

  console.log("ok: imports, fair enrichment, evidence/reviews, API history, source conflicts, research notes, filters, and conversion safety");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
