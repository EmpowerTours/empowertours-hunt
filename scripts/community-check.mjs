#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Does this repo's history look like a team built it?
//
// The Monad Foundation's Best Community Team Project rubric is judged on commit
// history: judges look for gradual buildup across multiple authors, and treat
// single-author dumps and last-day squashes as a fraud signal. One person
// committing "to save time" forfeits the bounty, and no late effort recovers
// it — the evidence is the history itself, and history cannot be backdated.
//
// So this is a GATE, not a report. A rule nobody can run is not a control: the
// point is to fail out loud, early, on the days when there is still time to do
// something about it. Run it whenever you like; run it in CI if you want the
// reminder to be automatic.
//
//   node scripts/community-check.mjs
//   node scripts/community-check.mjs --since 2026-09-01 --until 2026-10-13
//
// Exits non-zero when the history would read as single-author.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";

// The Metropolis build window. Overridable because the same check is useful
// for any window somebody wants to look at.
const DEFAULTS = { since: "2026-09-01", until: "2026-10-13" };

const UNIT = "\x1f"; // field separator
const RECORD = "\x1e"; // record separator

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const since = arg("since", DEFAULTS.since);
const until = arg("until", DEFAULTS.until);

/**
 * Commits in the window.
 *
 * Author date, not commit date. A rebase rewrites commit dates and would make
 * a month of genuine work look like it all happened this afternoon — which is
 * precisely the pattern the rubric treats as fraud. Author date is what
 * actually records when somebody did the work.
 */
function readCommits() {
  const out = execFileSync(
    "git",
    [
      "log",
      `--since=${since}`,
      `--until=${until} 23:59:59`,
      `--pretty=format:%H${UNIT}%ae${UNIT}%an${UNIT}%aI${RECORD}`,
      "--no-merges",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );

  return out
    .split(RECORD)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, email, name, iso] = r.split(UNIT);
      return { hash, email: email.toLowerCase(), name, day: iso.slice(0, 10) };
    });
}

function summarise(commits) {
  const byAuthor = new Map();
  const byDay = new Map();

  for (const c of commits) {
    if (!byAuthor.has(c.email)) {
      byAuthor.set(c.email, { name: c.name, commits: 0, days: new Set() });
    }
    const a = byAuthor.get(c.email);
    a.commits += 1;
    a.days.add(c.day);
    byDay.set(c.day, (byDay.get(c.day) ?? 0) + 1);
  }

  const total = commits.length;
  const authors = [...byAuthor.entries()]
    .map(([email, a]) => ({ email, ...a, days: a.days.size }))
    .sort((x, y) => y.commits - x.commits);

  const busiestDay = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    total,
    authors,
    activeDays: byDay.size,
    busiestDay: busiestDay
      ? { day: busiestDay[0], commits: busiestDay[1] }
      : null,
    topShare: total > 0 && authors.length > 0 ? authors[0].commits / total : 0,
    busiestShare: total > 0 && busiestDay ? busiestDay[1] / total : 0,
  };
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

const commits = readCommits();
const s = summarise(commits);

console.log(`\nCommunity Team check — ${since} to ${until}`);
console.log(`${"-".repeat(58)}`);

if (s.total === 0) {
  console.log("No commits in the window at all.");
  console.log("\nFAIL: there is no history to judge.\n");
  process.exit(1);
}

console.log(`commits        ${s.total}`);
console.log(`authors        ${s.authors.length}`);
console.log(`active days    ${s.activeDays}`);
if (s.busiestDay) {
  console.log(
    `busiest day    ${s.busiestDay.day} (${s.busiestDay.commits}, ${pct(s.busiestShare)} of all)`,
  );
}

console.log(
  `\n${"author".padEnd(30)}${"commits".padStart(9)}${"days".padStart(7)}`,
);
for (const a of s.authors) {
  const who = `${a.name} <${a.email}>`.slice(0, 29);
  console.log(
    `${who.padEnd(30)}${String(a.commits).padStart(9)}${String(a.days).padStart(7)}`,
  );
}

// --- the gate -------------------------------------------------------------

const problems = [];
const warnings = [];

if (s.authors.length < 2) {
  problems.push(
    "Only one author. The rubric names this outright: one person committing " +
      '"to save time" forfeits the $5,000, and week-five effort cannot recover it.',
  );
}

// A second author who has made two commits is not a team; they are a rounding
// error. The rubric asks whether a team built this, and a 95% share answers no
// however many names appear.
if (s.authors.length >= 2 && s.topShare > 0.95) {
  warnings.push(
    `One author holds ${pct(s.topShare)} of commits. More names in the log does not ` +
      "help if the distribution still reads as one person.",
  );
}

if (s.busiestShare > 0.5) {
  warnings.push(
    `${pct(s.busiestShare)} of all commits land on ${s.busiestDay.day}. ` +
      "That is the shape of a dump, which the rubric treats as a fraud signal.",
  );
}

if (s.activeDays < 5) {
  warnings.push(
    `Work appears on only ${s.activeDays} distinct day(s). "Gradual buildup" is the ` +
      "phrase judges are looking for.",
  );
}

console.log("");
for (const w of warnings) console.log(`WARN  ${w}\n`);
for (const p of problems) console.log(`FAIL  ${p}\n`);

if (problems.length > 0) {
  console.log(
    "Non-developer contributions count in full: translated copy, README edits,\n" +
      "test logs. What does not count is you committing somebody else's work for\n" +
      "them — the author field is the evidence. See CONTRIBUTING.md.\n",
  );
  process.exit(1);
}

if (warnings.length === 0) {
  console.log("OK — reads as a team building gradually.\n");
}
