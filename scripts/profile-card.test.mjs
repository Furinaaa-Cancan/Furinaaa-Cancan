import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchProfile, summarize, renderCard, renderDailySummary } from './profile-card.mjs';

function profile(counts, start = '2026-10-01') {
  return {
    login: 'example', name: 'Example', createdAt: `${start}T12:00:00Z`,
    stars: 185, repositories: 12, prs: 51, issues: 95,
    days: counts.map((contributionCount, index) => ({
      date: new Date(Date.parse(start) + index * 86_400_000).toISOString().slice(0, 10),
      contributionCount,
    })),
  };
}

test('today can be unfinished without breaking the current streak', () => {
  const data = summarize(profile([0, 2, 3, 1, 0]), new Date('2026-10-05T10:00:00Z'));
  assert.equal(data.current, 3);
  assert.equal(data.longest, 3);
  assert.equal(data.contributions, 6);
  assert.equal(data.recent.length, 30);
  assert.equal(data.recentTotal, 6);
  assert.equal(data.currentStart, '2026-10-02');
  assert.equal(data.currentEnd, '2026-10-04');
  assert.equal(data.longestStart, '2026-10-02');
  assert.equal(data.longestEnd, '2026-10-04');
});

test('daily snapshot changes at Beijing midnight even when statistics and UTC date do not', () => {
  const data = summarize(profile([0, 2, 3, 1, 0]), new Date('2026-10-05T10:00:00Z'));
  const before = JSON.parse(renderDailySummary(data, new Date('2026-10-05T15:59:59Z')));
  const after = JSON.parse(renderDailySummary(data, new Date('2026-10-05T16:00:00Z')));
  assert.equal(before.date, '2026-10-05');
  assert.equal(after.date, '2026-10-06');
  assert.deepEqual({ ...before, date: after.date }, after);
  assert.equal(after.calendarThroughUtcDate, '2026-10-05');
  assert.equal(after.totalContributions, 6);
  assert.equal(after.currentStreakDays, 3);
  assert.equal(after.stars, 185);
  assert.equal(renderDailySummary(data, new Date('2026-10-05T17:00:00Z')), JSON.stringify(after, null, 2) + '\n');
});

test('a missed completed day breaks the streak and leaves the historical maximum intact', () => {
  const data = summarize(profile([1, 1, 1, 0, 1, 0, 0]), new Date('2026-10-07T23:00:00Z'));
  assert.equal(data.current, 0);
  assert.equal(data.longest, 3);
  assert.equal(data.currentStart, null);
  assert.equal(data.currentEnd, null);
});

test('streak includes today when active and handles leap days', () => {
  const data = summarize(profile([1, 2, 3], '2024-02-28'), new Date('2024-03-01T01:00:00Z'));
  assert.equal(data.current, 3);
  assert.equal(data.longest, 3);
  assert.equal(data.contributions, 6);
  assert.equal(data.currentStart, '2024-02-28');
  assert.equal(data.longestEnd, '2024-03-01');
});

test('calendar duplicates do not inflate totals; conflicting or missing dates fail', () => {
  const input = profile([2, 3, 4]);
  input.days.push({ ...input.days[0] });
  const now = new Date('2026-10-03T10:00:00Z');
  assert.equal(summarize(input, now).contributions, 9);
  input.days.push({ date: input.days[0].date, contributionCount: 8 });
  assert.throws(() => summarize(input, now), /Conflicting/);
  assert.throws(() => summarize(profile([2]), now), /Incomplete/);
  assert.throws(() => summarize(profile([-1]), now), /Invalid/);
});

test('desktop and mobile panels handle an empty activity period and escape user text', () => {
  const data = summarize(profile([0, 0, 0]), new Date('2026-10-03T10:00:00Z'));
  data.name = 'A&B<test>';
  data.login = 'A&B<test>';
  for (const compact of [false, true]) {
    const svg = renderCard(data, compact);
    const markup = svg.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, 'embedded-image');
    assert.ok(svg.includes('A&amp;B&lt;test&gt;'), 'user text must be escaped');
    assert.ok(!/NaN|Infinity|undefined/.test(markup), 'all coordinates and values must be finite');
    assert.ok(svg.includes('0 contributions in the last 30 days'));
    assert.ok(svg.includes(compact ? 'viewBox="0 0 480 828"' : 'viewBox="0 0 960 576"'));
    assert.ok(svg.includes('href="data:image/png;base64,'), 'character must be self-contained');
    assert.ok(!svg.includes('href="http'), 'SVG images must not depend on remote resources');
  }
});

test('API collector paginates public stars and queries all account years', async () => {
  const queries = [];
  const responses = [
    { user: { login: 'example', name: 'Example', createdAt: '2024-08-16T10:00:00Z' },
      prs: { issueCount: 51 }, issues: { issueCount: 95 } },
    { user: { repositories: { nodes: [{ stargazerCount: 4 }], pageInfo: { hasNextPage: true, endCursor: 'next' } } } },
    { user: { repositories: { nodes: [{ stargazerCount: 7 }], pageInfo: { hasNextPage: false } } } },
    { user: { y2024: { contributionCalendar: { weeks: [{ contributionDays: [{ date: '2024-08-16', contributionCount: 3 }] }] } } } },
  ];
  const request = async (url, options) => {
    assert.equal(url, 'https://api.github.com/graphql');
    queries.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ data: responses.shift() }) };
  };
  const result = await fetchProfile('example', 'test-token', new Date('2026-10-21T10:00:00Z'), request);
  assert.equal(result.stars, 11);
  assert.equal(result.repositories, 2);
  assert.equal(result.prs, 51);
  assert.equal(result.issues, 95);
  assert.equal(queries[0].variables.prQuery, 'author:example is:pr is:public');
  assert.equal(result.days.length, 1);
  assert.match(queries[1].query, /privacy: PUBLIC/);
  assert.equal(queries[2].variables.after, 'next');
  assert.match(queries[3].query, /y2024:/);
  assert.match(queries[3].query, /y2025:/);
  assert.match(queries[3].query, /y2026:/);
});

test('API errors fail the render instead of publishing fabricated zero statistics', async () => {
  const request = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'Rate limited' }] }) });
  await assert.rejects(fetchProfile('example', 'test-token', new Date(), request), /Rate limited/);
});
