import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMonitor, normalizePlan, normalizeAnnouncements } from '../src/monitor.mjs';
import { requestJson, barkEndpoint } from '../src/http.mjs';

const r = (id, type = 'regular') => ({
  id, reset_type: type, announced_at: '2026-10-22T17:00:00Z',
  text: `Reset ${id}`, source: { url: `https://x.com/test/status/${id}` }
});
const s = (plan = null) => ({ data: { latest_reset: r('1'), scheduled_reset: plan, active_watch: null } });
const plan = (time) => ({
  id: 'plan-12', scheduled_for: time, text: 'Reset expected soon',
  source: { url: 'https://x.com/test/status/plan-12' }
});

function mockServer({ status = s(), rows = [r('1')], barkCodes = [], rejectBark = false } = {}) {
  const pushed = [];
  let barkCalls = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/v1/status')) return Response.json(status);
    if (url.includes('/api/v1/resets')) return Response.json({ data: rows });
    if (url === 'https://bark.test/push') {
      const body = JSON.parse(options.body);
      pushed.push(body);
      barkCalls++;
      if (rejectBark) return Response.json({ code: 401, message: 'bad key' });
      const code = barkCodes[barkCalls - 1] ?? 200;
      return Response.json({ code }, { status: code === 503 ? 503 : 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { fetchImpl, pushed, get barkCalls() { return barkCalls; } };
}
async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'codex-monitor-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  return join(temp, 'state.json');
}
const noopLogger = { info() {}, warn() {} };
const opts = (path, server) => ({ statePath: path, fetchImpl: server.fetchImpl,
  serverUrl: 'https://bark.test', deviceKey: 'test-key',
  logger: noopLogger, sleep: async () => {} });
const load = (path) => readFile(path, 'utf8').then(JSON.parse);

test('首次运行只建基线，重复检查静默', async (t) => {
  const path = await fixture(t);
  const server = mockServer({ status: s(plan('2026-10-24T10:00:00Z')), rows: [r('2'), r('1')] });
  assert.equal((await runMonitor(opts(path, server))).initialized, true);
  assert.equal((await runMonitor(opts(path, server))).sent, 0);
  assert.equal(server.pushed.length, 0);
  const state = await load(path);
  assert.deepEqual(state.seenIds, ['2', '1']);
  assert.ok(state.plan.signature);
});

test('新增历史只发送未见过的两条，按时间从旧到新', async (t) => {
  const path = await fixture(t);
  const first = mockServer({ rows: [r('1')] });
  await runMonitor(opts(path, first));
  const second = mockServer({ rows: [r('3', 'banked'), r('2'), r('1')] });
  assert.equal((await runMonitor(opts(path, second))).sent, 2);
  assert.match(second.pushed[0].body, /Reset 2/);
  assert.match(second.pushed[1].body, /Reset 3/);
  assert.equal(second.pushed[0].device_key, 'test-key');
  assert.equal((await runMonitor(opts(path, second))).sent, 0);
  assert.equal(second.pushed.length, 2);
});

test('预定计划新增、改期和消失只各发一次，且不声称取消', async (t) => {
  const path = await fixture(t);
  await runMonitor(opts(path, mockServer()));
  const next = mockServer({ status: s(plan('2026-10-24T10:00:00Z')) });
  await runMonitor(opts(path, next));
  assert.match(next.pushed[0].title, /新增预定/);
  const updated = mockServer({ status: s(plan('2026-10-25T11:00:00Z')) });
  await runMonitor(opts(path, updated));
  assert.match(updated.pushed[0].title, /更新/);
  const vanished = mockServer();
  await runMonitor(opts(path, vanished));
  assert.match(vanished.pushed[0].title, /不再显示/);
  assert.doesNotMatch(vanished.pushed[0].body, /已经取消/);
  await runMonitor(opts(path, vanished));
  assert.equal(vanished.pushed.length, 1);
});

test('新公告与计划消失同批出现，避免重复推送', async (t) => {
  const path = await fixture(t);
  await runMonitor(opts(path, mockServer({ status: s(plan('2026-10-24T10:00:00Z')) })));
  const server = mockServer({ rows: [r('2'), r('1')] });
  assert.equal((await runMonitor(opts(path, server))).sent, 1);
  assert.equal(server.pushed.length, 1);
  assert.equal((await load(path)).plan, null);
});

test('前一条成功后一条失败，成功记录保留，失败记录下次重试', async (t) => {
  const path = await fixture(t);
  await runMonitor(opts(path, mockServer()));
  const failing = mockServer({ rows: [r('3'), r('2'), r('1')], barkCodes: [200, 503, 503, 503] });
  await assert.rejects(runMonitor(opts(path, failing)), /HTTP 503/);
  assert.deepEqual((await load(path)).seenIds, ['1', '2']);
  const recovered = mockServer({ rows: [r('3'), r('2'), r('1')] });
  await runMonitor(opts(path, recovered));
  assert.equal(recovered.pushed.length, 1);
  assert.match(recovered.pushed[0].body, /Reset 3/);
});

test('Bark HTTP 200 但业务 code 401 不算成功，不会错误去重', async (t) => {
  const path = await fixture(t);
  await runMonitor(opts(path, mockServer()));
  await assert.rejects(runMonitor(opts(path, mockServer({ rows: [r('2'), r('1')], rejectBark: true }))), /code=200/);
  assert.deepEqual((await load(path)).seenIds, ['1']);
});

test('测试推送模式不会初始化或修改状态', async (t) => {
  const path = await fixture(t);
  const server = mockServer();
  await runMonitor({ ...opts(path, server), testPush: true });
  assert.equal(server.pushed.length, 1);
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
});

test('无效状态结构拒绝运行，防止清空计划误报', () => {
  assert.throws(() => normalizePlan({ data: { scheduled: null } }), /scheduled_reset/);
  assert.throws(() => normalizeAnnouncements({ data: [] }), /非空数组/);
  assert.throws(() => normalizeAnnouncements({ data: [r('1'), r('1')] }), /重复 id/);
});

test('遵循 Retry-After 的 429，避免超长占用运行器', async () => {
  let count = 0;
  const sleep = [];
  const fetchImpl = async () => {
    count++;
    return count === 1
      ? Response.json({}, { status: 429, headers: { 'Retry-After': '2' } })
      : Response.json({ done: true });
  };
  const result = await requestJson('https://example.test/', { fetchImpl, sleep: async (ms) => sleep.push(ms) });
  assert.equal(result.done, true);
  assert.deepEqual(sleep, [2000]);
  await assert.rejects(requestJson('https://example.test/', {
    fetchImpl: async () => Response.json({}, { status: 429, headers: { 'Retry-After': '90' } }),
    sleep: async () => { throw new Error('Should not wait 90s'); }
  }), /较长等待/);
});

test('要求 SERVER_URL 是 HTTPS 且从不将 Key 拼到 URL', () => {
  assert.equal(barkEndpoint('https://bark.example.com/base/'), 'https://bark.example.com/base/push');
  assert.throws(() => barkEndpoint('http://bark.example.com'), /HTTPS/);
  assert.throws(() => barkEndpoint('https://key:b@bark.example.com'), /HTTPS/);
});

test('Bark HTTP 200 但业务 code 503 也会重试', async (t) => {
  const path = await fixture(t);
  await runMonitor(opts(path, mockServer()));
  const server = mockServer({ rows: [r('2'), r('1')], barkCodes: [503, 200] });
  const result = await runMonitor(opts(path, server));
  assert.equal(result.sent, 1);
  assert.equal(server.barkCalls, 2);
  assert.deepEqual((await load(path)).seenIds, ['1', '2']);
});
