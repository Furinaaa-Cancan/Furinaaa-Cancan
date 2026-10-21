import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchProfile, summarize, renderCard } from './profile-card.mjs';

function profile(counts, start = '2026-10-01') {
  return {
    login: 'example', createdAt: `${start}T12:00:00Z`, stars: 185, repositories: 12,
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
});

test('a missed completed day breaks the streak and leaves the historical maximum intact', () => {
  const data = summarize(profile([1, 1, 1, 0, 1, 0, 0]), new Date('2026-10-07T23:00:00Z'));
  assert.equal(data.current, 0);
  assert.equal(data.longest, 3);
});

test('streak includes today when active and handles leap days', () => {
  const data = summarize(profile([1, 2, 3], '2024-02-28'), new Date('2024-03-01T01:00:00Z'));
  assert.equal(data.current, 3);
  assert.equal(data.longest, 3);
  assert.equal(data.contributions, 6);
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
  data.login = 'A&B<test>';
  for (const compact of [false, true]) {
    const svg = renderCard(data, compact);
    assert.match(svg, /A&amp;B&lt;test&gt;/);
    assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
    assert.match(svg, /0 contributions \/ 30 days/);
    assert.match(svg, compact ? /viewBox="0 0 480 680"/ : /viewBox="0 0 960 520"/);
  }
});

test('API collector paginates public stars and queries all account years', async () => {
  const queries = [];
  const responses = [
    { user: { login: 'example', createdAt: '2024-08-16T10:00:00Z' } },
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
