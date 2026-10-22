// Dependency-free GitHub activity panel. Usage: node scripts/profile-card.mjs [directory] [login]
// Actions uses GITHUB_TOKEN; local runs use the existing GitHub CLI authentication.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

  const { user, prs, issues } = await graphql(`query ($login: String!, $prQuery: String!, $issueQuery: String!) {
    user(login: $login) { login name createdAt }
    prs: search(query: $prQuery, type: ISSUE, first: 1) { issueCount }
    issues: search(query: $issueQuery, type: ISSUE, first: 1) { issueCount }
  }`, {
    login,
    prQuery: `author:${login} is:pr is:public`,
    issueQuery: `author:${login} is:issue is:public`,
  });
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
  return { login: user.login, name: user.name || user.login, createdAt: user.createdAt,
    stars, repositories, prs: prs.issueCount, issues: issues.issueCount, days };
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
  let longestStart = null;
  let longestEnd = null;
  for (const [index, day] of days.entries()) {
    run = day.count > 0 ? run + 1 : 0;
    if (run > longest) {
      longest = run;
      longestStart = days[index - run + 1].date;
      longestEnd = day.date;
    }
  }
  // An unfinished UTC day does not break yesterday's streak.
  let end = days.length - 1;
  if (days[end].count === 0) end--;
  const currentEnd = end >= 0 && days[end].count > 0 ? days[end].date : null;
  let current = 0;
  while (end >= 0 && days[end].count > 0) { current++; end--; }
  const currentStart = current > 0 ? days[end + 1].date : null;
  const recent = Array.from({ length: 30 }, (_, index) => {
    const date = isoDay(Date.parse(`${today}T00:00:00Z`) - (29 - index) * DAY);
    return { date, count: byDate.get(date) ?? 0 };
  });
  return {
    login: profile.login, name: profile.name || profile.login, created, updated: today,
    contributions: days.reduce((sum, day) => sum + day.count, 0),
    stars: profile.stars, repositories: profile.repositories,
    prs: profile.prs, issues: profile.issues,
    activeDays: days.slice(-365).filter((day) => day.count > 0).length,
    current, currentStart, currentEnd, longest, longestStart, longestEnd, recent,
    recentTotal: recent.reduce((sum, day) => sum + day.count, 0),
  };
}

// Three coordinated cards: stats and streak side by side, then a full-width graph.
// Compact layout stacks the same cards without shrinking their labels.
export function renderCard(data, compact = false) {
  const width = compact ? 480 : 960;
  const cardWidth = compact ? 480 : 470;
  const topHeight = 240;
  const gap = compact ? 16 : 20;
  const chartY = compact ? (topHeight + gap) * 2 : topHeight + gap;
  const chartHeight = 316;
  const height = chartY + chartHeight;
  const activeDays = data.activeDays;
  const remImage = readFileSync(new URL('../profile/assets/rem-moon.png', import.meta.url)).toString('base64');
  const range = (from, to) => from && to ? `${dateLabel(from)} – ${dateLabel(to)}` : 'No active streak';
  const flower = (x, y, scale = 1) => `<g transform="translate(${x}, ${y}) scale(${scale})" fill="#fffdf4" stroke="#b8cce2" stroke-width=".65">${Array.from({ length: 5 }, (_, i) => `<ellipse cx="0" cy="-5.8" rx="3.6" ry="5.6" transform="rotate(${i * 72})"/>`).join('')}<circle r="2.6" fill="#eab9c8" stroke="none"/></g>`;
  const frame = (w, h) => `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="20" fill="url(#card-bg)" stroke="#b9cde1"/>
    <rect x="4" y="4" width="${w - 8}" height="${h - 8}" rx="17" fill="none" stroke="#fffef9" stroke-opacity=".85"/>
    <path d="M${w - 130} 1Q${w - 80} 56 ${w - 1} 73V21Q${w - 1} 1 ${w - 21} 1Z" fill="#d4e5f4" opacity=".33"/>
    <rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="20" filter="url(#paper)"/>`;
  const rowIcons = [
    '<path d="m8 1.5 2 4 4.5.7-3.3 3.2.8 4.6L8 11.8 4 14l.8-4.6L1.5 6.2 6 5.5Z"/>',
    '<circle cx="8" cy="8" r="2.7"/><path d="M1 8h4m6 0h4"/>',
    '<circle cx="4" cy="3" r="1.6"/><circle cx="4" cy="13" r="1.6"/><circle cx="12" cy="13" r="1.6"/><path d="M4 4.6v6.8M12 11.4V6a3 3 0 0 0-3-3H8m0 0 2-2M8 3l2 2"/>',
    '<circle cx="8" cy="8" r="6"/><path d="M8 4.5v4M8 11h.01"/>',
    '<path d="M3 2h10v12H3zM5.5 2v12M8 5h2.5M8 8h2.5"/>',
  ];
  const rows = [
    ['Stars earned', data.stars],
    ['Total contributions', data.contributions],
    ['Pull requests', data.prs],
    ['Issues opened', data.issues],
    ['Public repositories', data.repositories],
  ].map(([label, value], index) => `<g transform="translate(26, ${82 + index * 27})">
    <g fill="none" stroke="#83a3c9" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round">${rowIcons[index]}</g>
    <text class="label" x="27" y="12">${label}</text>
    <text class="row-value" x="243" y="12" text-anchor="end">${number(value)}</text>
  </g>`).join('');
  const stats = `<g>
    ${frame(cardWidth, topHeight)}
    <text class="heading" x="26" y="36">${escape(data.name)}'s GitHub Stats</text>
    <text class="caption muted" x="26" y="56">@${escape(data.login)}</text>
    ${rows}
    <image x="${cardWidth - 169}" y="53" width="146" height="183" href="data:image/png;base64,${remImage}"/>
    <text class="micro muted" x="26" y="224">${number(activeDays)} active days in the past year</text>
  </g>`;
  const streakX = compact ? 0 : cardWidth + gap;
  const streakY = compact ? topHeight + gap : 0;
  const center = cardWidth / 2;
  const streak = `<g transform="translate(${streakX}, ${streakY})">
    ${frame(cardWidth, topHeight)}
    <text class="heading" x="26" y="36">Contribution Streak</text>
    <text class="caption muted" x="26" y="56">Since ${dateLabel(data.created)}, ${data.created.slice(0, 4)}</text>
    <path d="M151 95v72M${cardWidth - 151} 95v72" stroke="#d4e0ed"/>
    <text class="side-value" x="78" y="127" text-anchor="middle">${number(data.contributions)}</text>
    <text class="caption" x="78" y="150" text-anchor="middle">Contributions</text>
    <text class="micro muted" x="78" y="172" text-anchor="middle">All time</text>
    <circle cx="${center}" cy="126" r="56" fill="none" stroke="#e3eaf4" stroke-width="5"/>
    <circle cx="${center}" cy="126" r="56" fill="none" stroke="url(#accent)" stroke-width="3"/>
    <circle cx="${center}" cy="70" r="12" fill="#fcfcf8"/>
    ${flower(center, 70, .94)}
    <path d="M${center + 68} 79v8m-4-4h8" stroke="#d9b1c5" stroke-width="1.5" stroke-linecap="round"/>
    <text class="streak-value" x="${center}" y="128" text-anchor="middle">${number(data.current)}</text>
    <text class="caption accent" x="${center}" y="150" text-anchor="middle">Current streak</text>
    <text class="micro muted" x="${center}" y="202" text-anchor="middle">${range(data.currentStart, data.currentEnd)}</text>
    <text class="side-value" x="${cardWidth - 78}" y="127" text-anchor="middle">${number(data.longest)}</text>
    <text class="caption" x="${cardWidth - 78}" y="150" text-anchor="middle">Longest streak</text>
    <text class="micro muted" x="${cardWidth - 78}" y="172" text-anchor="middle">${range(data.longestStart, data.longestEnd)}</text>
    <text class="micro muted" x="26" y="224">One day at a time.</text>
  </g>`;
  const plot = { x: compact ? 47 : 56, y: 88, width: width - (compact ? 72 : 86), height: 151 };
  const max = Math.max(1, ...data.recent.map((day) => day.count));
  const power = 10 ** Math.floor(Math.log10(max));
  const unit = max / power <= 2 ? power / 2 : max / power <= 5 ? power : power * 2.5;
  const top = Math.ceil(max / unit) * unit;
  const grid = [0, 0.5, 1].map((ratio) => {
    const y = plot.y + plot.height * (1 - ratio);
    return `<path d="M${plot.x} ${y}H${width - 30}" class="grid" ${ratio ? 'stroke-dasharray="3 6"' : ''}/>
      <text class="tick muted" x="${plot.x - 12}" y="${y + 4}" text-anchor="end">${number(top * ratio)}</text>`;
  }).join('');
  const points = data.recent.map((day, index) => ({
    ...day, x: plot.x + index / 29 * plot.width, y: plot.y + plot.height * (1 - day.count / top),
  }));
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const bottom = plot.y + plot.height;
  const area = `${line} L${(plot.x + plot.width).toFixed(2)} ${bottom} L${plot.x} ${bottom} Z`;
  const indices = compact ? [0, 7, 14, 21, 29] : [0, 5, 10, 15, 20, 25, 29];
  const ticks = indices.map((index) => `<text class="tick muted" x="${points[index].x.toFixed(2)}" y="${bottom + 24}" text-anchor="${index === 0 ? 'start' : index === 29 ? 'end' : 'middle'}">${dateLabel(points[index].date)}</text>`).join('');
  const last = points.at(-1);
  const chart = `<g transform="translate(0, ${chartY})">
    ${frame(width, chartHeight)}
    <text class="heading" x="26" y="36">Contribution Activity</text>
    <text class="caption muted" x="${compact ? 26 : width - 70}" y="${compact ? 59 : 36}" text-anchor="${compact ? 'start' : 'end'}">${dateLabel(points[0].date)} – ${dateLabel(last.date)}, ${data.updated.slice(0, 4)}</text>
    ${flower(width - 35, 33, 1.05)}
    ${grid}
    <path d="${area}" fill="url(#area)"/>
    <path d="${line}" fill="none" stroke="#83a7ce" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${points.map((point) => `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="2.3" fill="#9cb9d9"><title>${point.date}: ${number(point.count)} contributions</title></circle>`).join('')}
    <circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="6" fill="#e4b0c4" fill-opacity=".15"/>
    <circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="3" fill="#d7a2bc"/>
    ${ticks}
    <text class="caption" x="26" y="294"><tspan class="accent" font-weight="600">${number(data.recentTotal)}</tspan><tspan class="muted" dx="4">contributions in the last 30 days</tspan></text>
    <text class="micro subdued" x="${width - 28}" y="294" text-anchor="end">${compact ? 'UTC' : `Updated ${data.updated} · UTC`}</text>
  </g>`;
  const description = `${data.login}: ${number(data.contributions)} all-time contributions, ${data.stars} stars, ${data.prs} public pull requests, ${data.issues} public issues, ${data.repositories} public repositories, ${activeDays} active days in the last 365 days. Current streak ${data.current} days (${range(data.currentStart, data.currentEnd)}), longest streak ${data.longest} days (${range(data.longestStart, data.longestEnd)}). ${number(data.recentTotal)} contributions in the last 30 days. Updated ${data.updated} UTC.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escape(data.name)}'s GitHub stats, contribution streak and activity</title>
  <desc id="desc">${escape(description)}</desc>
  <defs>
    <linearGradient id="card-bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fffdf7"/><stop offset="1" stop-color="#f0f5fc"/></linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#acc9e6"/><stop offset=".55" stop-color="#7ea6d2"/><stop offset="1" stop-color="#b3a8d1"/></linearGradient>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#9abce2" stop-opacity=".38"/><stop offset="1" stop-color="#b4cce8" stop-opacity=".025"/></linearGradient>
    <filter id="paper" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".72" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".035"/></feComponentTransfer><feComposite in2="SourceAlpha" operator="in"/></filter>
  </defs>
  <style>
    text { font-family: 'Nunito', 'Avenir Next', 'Segoe UI', Helvetica, Arial, sans-serif; fill: #49617f; font-variant-numeric: tabular-nums; }
    .heading { font-size: 19px; font-weight: 600; letter-spacing: -.3px; fill: #58769a; }
    .label { font-size: 13px; fill: #5c7290; }
    .row-value { font-size: 14px; font-weight: 600; }
    .streak-value { font-size: 36px; font-weight: 600; letter-spacing: -1px; fill: #4c709b; }
    .side-value { font-size: 26px; font-weight: 600; letter-spacing: -.7px; }
    .caption { font-size: 12px; }
    .micro { font-size: 10px; }
    .tick { font-size: 10.5px; }
    .muted { fill: #60728c; }
    .accent { fill: #57759d; }
    .grid { fill: none; stroke: #9cb4ce; stroke-opacity: .27; stroke-width: 1; }
  </style>
  ${stats}${streak}${chart}
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
