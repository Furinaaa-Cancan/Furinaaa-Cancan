// Dependency-free GitHub activity panel. Usage: node scripts/profile-card.mjs [directory] [login]
// Actions uses GITHUB_TOKEN; local runs use the existing GitHub CLI authentication.
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY = 86_400_000;
const isoDay = (date) => new Date(date).toISOString().slice(0, 10);
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const number = (n) => n.toLocaleString('en-US');
const dateLabel = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', timeZone: 'UTC',
});

export async function fetchProfile(login, token, now = new Date(), request = fetch) {
  async function graphql(query, variables = {}) {
    const response = await request('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    if (!response.ok || body.errors) {
      throw new Error(`GitHub API: ${body.errors?.map((error) => error.message).join('; ') || response.status}`);
    }
    return body.data;
  }

  const { user } = await graphql(`query ($login: String!) {
    user(login: $login) { login createdAt }
  }`, { login });
  if (!user) throw new Error(`GitHub user not found: ${login}`);

  let stars = 0;
  let repositories = 0;
  for (let after = null; ;) {
    const page = await graphql(`query ($login: String!, $after: String) {
      user(login: $login) {
        repositories(first: 100, privacy: PUBLIC, ownerAffiliations: OWNER, after: $after) {
          nodes { stargazerCount }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`, { login, after });
    const repos = page.user.repositories;
    repositories += repos.nodes.length;
    stars += repos.nodes.reduce((total, repo) => total + repo.stargazerCount, 0);
    if (!repos.pageInfo.hasNextPage) break;
    if (!repos.pageInfo.endCursor || repos.pageInfo.endCursor === after) {
      throw new Error('GitHub returned an invalid repository pagination cursor');
    }
    after = repos.pageInfo.endCursor;
  }

  // Calendar years prevent overlapping contribution dates at query boundaries.
  const windows = [];
  for (let year = new Date(user.createdAt).getUTCFullYear(); year <= now.getUTCFullYear(); year++) {
    const from = `${year}-01-01T00:00:00Z`;
    const to = year === now.getUTCFullYear() ? now.toISOString() : `${year}-12-31T23:59:59Z`;
    windows.push(`y${year}: contributionsCollection(from: "${from}", to: "${to}") {
      contributionCalendar { weeks { contributionDays { date contributionCount } } }
    }`);
  }
  const history = await graphql(`query ($login: String!) {
    user(login: $login) { ${windows.join('\n')} }
  }`, { login });
  const days = Object.values(history.user).flatMap((year) =>
    year.contributionCalendar.weeks.flatMap((week) => week.contributionDays));
  return { login: user.login, createdAt: user.createdAt, stars, repositories, days };
}

export function summarize(profile, now = new Date()) {
  const today = isoDay(now);
  const created = isoDay(profile.createdAt);
  const byDate = new Map();
  for (const { date, contributionCount } of profile.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(contributionCount) || contributionCount < 0) {
      throw new Error('Invalid GitHub contribution day');
    }
    if (date < created || date > today) continue;
    if (byDate.has(date) && byDate.get(date) !== contributionCount) {
      throw new Error(`Conflicting contribution counts for ${date}`);
    }
    byDate.set(date, contributionCount);
  }
  // A missing API date is a failed fetch, not a zero-contribution day.
  const days = [];
  for (let timestamp = Date.parse(`${created}T00:00:00Z`); isoDay(timestamp) <= today; timestamp += DAY) {
    const date = isoDay(timestamp);
    if (!byDate.has(date)) throw new Error(`Incomplete GitHub calendar: ${date}`);
    days.push({ date, count: byDate.get(date) });
  }
  if (!days.length) throw new Error('Empty GitHub contribution calendar');

  let run = 0;
  let longest = 0;
  for (const day of days) {
    run = day.count > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // An unfinished UTC day does not break yesterday's streak.
  let end = days.length - 1;
  if (days[end].count === 0) end--;
  let current = 0;
  while (end >= 0 && days[end--].count > 0) current++;
  const recent = Array.from({ length: 30 }, (_, index) => {
    const date = isoDay(Date.parse(`${today}T00:00:00Z`) - (29 - index) * DAY);
    return { date, count: byDate.get(date) ?? 0 };
  });
  return {
    login: profile.login, created, updated: today,
    contributions: days.reduce((sum, day) => sum + day.count, 0),
    stars: profile.stars, repositories: profile.repositories,
    current, longest, recent,
    recentTotal: recent.reduce((sum, day) => sum + day.count, 0),
  };
}

export function renderCard(data, compact = false) {
  const width = compact ? 480 : 960;
  const height = compact ? 680 : 520;
  const margin = compact ? 28 : 40;
  const metrics = [
    ['Contributions', data.contributions, 'all time'],
    ['Current streak', data.current, 'consecutive days'],
    ['Longest streak', data.longest, 'consecutive days'],
    ['Stars earned', data.stars, 'public repositories'],
  ];
  const metricWidth = (width - margin * 2) / (compact ? 2 : 4);
  const metricBody = metrics.map(([label, value, note], index) => {
    const x = margin + (compact ? index % 2 : index) * metricWidth;
    const y = 101 + (compact ? Math.floor(index / 2) * 112 : 0);
    return `<g transform="translate(${x}, ${y})">
      <text class="label">${label}</text>
      <text class="value" y="47">${number(value)}</text>
      <text class="muted note" y="73">${note}</text>
    </g>`;
  }).join('');
  const dividerY = compact ? 318 : 210;
  const titleY = dividerY + 38;
  const plot = { x: margin + 34, y: dividerY + (compact ? 100 : 78), width: width - margin * 2 - 34, height: compact ? 144 : 128 };
  const maximum = Math.max(1, ...data.recent.map((day) => day.count));
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const top = Math.ceil(maximum / magnitude / 2) * magnitude * 2;
  const grid = [0, 0.5, 1].map((ratio) => {
    const y = plot.y + plot.height * (1 - ratio);
    return `<path class="grid" d="M${plot.x} ${y}H${width - margin}"/>
      <text class="tick muted" text-anchor="end" x="${plot.x - 12}" y="${y + 4}">${number(top * ratio)}</text>`;
  }).join('');
  const step = plot.width / data.recent.length;
  const barWidth = step * 0.63;
  const bars = data.recent.map((day, index) => {
    const barHeight = day.count / top * plot.height;
    const x = plot.x + step * index + (step - barWidth) / 2;
    const y = plot.y + plot.height - barHeight;
    if (day.count === 0) return '';
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="${Math.min(3, barHeight / 2).toFixed(2)}" fill="${index === 29 ? '#e6b98a' : '#8aada8'}">
      <title>${day.date}: ${number(day.count)} contributions</title>
    </rect>`;
  }).join('');
  const ticks = [0, 7, 14, 21, 29].map((index) =>
    `<text class="tick muted" text-anchor="middle" x="${(plot.x + (index + 0.5) * step).toFixed(2)}" y="${plot.y + plot.height + 24}">${dateLabel(data.recent[index].date)}</text>`).join('');
  const chartSummary = `${number(data.recentTotal)} contributions / 30 days`;
  const description = `${data.login}: ${number(data.contributions)} contributions since ${data.created}; current streak ${data.current} days; longest streak ${data.longest} days; ${data.stars} stars across ${data.repositories} public repositories. ${chartSummary}. Updated ${data.updated} UTC.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escape(data.login)} / GitHub activity</title>
  <desc id="desc">${escape(description)}</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: #eeeae4; }
    .eyebrow { font-size: 13px; font-weight: 600; letter-spacing: 2px; }
    .muted { fill: #a3acb8; }
    .label { font-size: 15px; fill: #c2c9d2; }
    .value { font-size: 42px; font-weight: 600; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
    .note { font-size: 12px; }
    .heading { font-size: 20px; font-weight: 600; }
    .tick { font-size: 11px; }
    .grid { fill: none; stroke: #303a47; stroke-width: 1; }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="18" fill="#18212d" stroke="#35404d"/>
  <text class="eyebrow" x="${margin}" y="43">GITHUB / ACTIVITY</text>
  <text class="note muted" x="${width - margin}" y="43" text-anchor="end">@${escape(data.login)}</text>
  ${metricBody}
  <path class="grid" d="M${margin} ${dividerY}H${width - margin}"/>
  <text class="heading" x="${margin}" y="${titleY}">Contribution activity</text>
  <text class="note muted" x="${compact ? margin : width - margin}" y="${compact ? titleY + 25 : titleY}" text-anchor="${compact ? 'start' : 'end'}">${chartSummary}</text>
  ${grid}${bars}${ticks}
  <path class="grid" d="M${margin} ${height - (compact ? 79 : 54)}H${width - margin}"/>
  <text class="note muted" x="${margin}" y="${height - (compact ? 52 : 27)}">GitHub contribution calendar · UTC</text>
  <text class="note muted" x="${compact ? margin : width - margin}" y="${height - 27}" text-anchor="${compact ? 'start' : 'end'}">Updated ${data.updated}</text>
</svg>\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [directory = 'profile', login = 'Furinaaa-Cancan'] = process.argv.slice(2);
    const token = process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const now = new Date();
    const data = summarize(await fetchProfile(login, token, now), now);
    mkdirSync(directory, { recursive: true });
    for (const [name, compact] of [['activity.svg', false], ['activity-mobile.svg', true]]) {
      const path = join(directory, name);
      writeFileSync(`${path}.tmp`, renderCard(data, compact));
      renameSync(`${path}.tmp`, path);
    }
    console.log(`Updated activity panels: ${number(data.contributions)} contributions, ${data.current}-day current streak, ${data.longest}-day longest streak, ${data.stars} stars; ${data.updated} UTC.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
