import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pushBark, requestJson } from './http.mjs';

const SOURCE = 'https://codex-resets.com';
const STATUS_API = `${SOURCE}/api/v1/status`;
const HISTORY_API = `${SOURCE}/api/v1/resets?limit=100`;
const DEFAULT_STATE = resolve('.data/state.json');

const value = (v) => v === undefined || v === null ? '' : String(v).trim();
const normalizeText = (v) => value(v).replace(/\s+/g, ' ');
const sourceLink = (v) => {
  const url = value(v?.source?.url || v?.source_url || v?.url);
  try {
    return /^https?:$/.test(new URL(url).protocol) ? url : SOURCE;
  } catch { return SOURCE; }
};

export function normalizeAnnouncements(payload) {
  if (!Array.isArray(payload?.data) || payload.data.length === 0) {
    throw new Error('历史 API 的 data 不是非空数组（不更新状态）');
  }
  const ids = new Set();
  const rows = payload.data.map((item) => {
    if (!item || !value(item.id)) throw new Error('历史记录缺少 id（不更新状态）');
    return {
      id: value(item.id),
      type: value(item.reset_type || item.type) || 'unknown',
      text: normalizeText(item.translation?.text || item.text || item.raw?.text),
      announcedAt: value(item.announced_at),
      url: sourceLink(item)
    };
  });
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error('历史 API 返回重复 id（不更新状态）');
    ids.add(row.id);
  }
  // Upstream currently returns newest first. We reverse only for oldest-to-newest delivery.
  return rows;
}

export function normalizePlan(payload) {
  if (!payload?.data || typeof payload.data !== 'object' ||
      !Object.hasOwn(payload.data, 'scheduled_reset')) {
    throw new Error('状态 API 缺少 data.scheduled_reset（不更新状态）');
  }
  const item = payload.data.scheduled_reset;
  if (item === null) return null;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('scheduled_reset 格式异常（不更新状态）');
  }
  // Deliberately omit rolling countdowns, server generated_at, and active_watch forecasts.
  const plan = {
    id: value(item.id),
    time: value(item.scheduled_for),
    day: value(item.day),
    whenText: normalizeText(item.when_text),
    text: normalizeText(item.text || item.raw?.text),
    announcedAt: value(item.announced_at),
    type: value(item.reset_type || item.type),
    status: value(item.status),
    url: sourceLink(item)
  };
  if (![plan.id, plan.time, plan.day, plan.whenText, plan.text, plan.announcedAt].some(Boolean)) {
    throw new Error('scheduled_reset 内容不完整（不更新状态）');
  }
  plan.signature = JSON.stringify(plan);
  return plan;
}

async function readState(path) {
  let content;
  try { content = await readFile(path, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const obj = JSON.parse(content);
  if (obj?.version !== 1 || !Array.isArray(obj.seenIds) ||
      !obj.seenIds.every((id) => typeof id === 'string') ||
      !Object.hasOwn(obj, 'plan')) {
    throw new Error('状态文件格式不兼容，停止运行以免误推送');
  }
  return obj;
}

async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

function displayTime(s, timeZone) {
  if (!s) return '';
  const date = new Date(s);
  if (!Number.isFinite(date.getTime())) return s;
  return `${new Intl.DateTimeFormat('zh-CN', {
    timeZone, dateStyle: 'medium', timeStyle: 'short'
  }).format(date)} (${timeZone})`;
}

export function announcementMessage(item, timeZone) {
  const kind = item.type === 'banked' ? '备用额度' : item.type === 'regular' ? '常规额度' : '新公告';
  return {
    title: `Codex ${kind}公告`,
    body: [item.text || 'Codex Resets 收录了一条新重置公告',
      item.announcedAt ? `公告时间：${displayTime(item.announcedAt, timeZone)}` : '',
      '来源：codex-resets.com；不代表个人额度已到账。'
    ].filter(Boolean).join('\n').slice(0, 1400),
    url: item.url
  };
}

export function planMessage(plan, previous, timeZone) {
  if (!plan) {
    return {
      title: 'Codex 预定公告不再显示',
      body: '此前的预定重置已从网站当前列表移除，可能已执行、撤回或发生变更；原因尚未确认。请查看来源。',
      url: previous?.url || SOURCE
    };
  }
  const detail = plan.time
    ? `参考时间：${displayTime(plan.time, timeZone)}`
    : plan.whenText || plan.day || '未提供确定时间';
  return {
    title: previous ? 'Codex 预定重置计划更新' : 'Codex 新增预定重置公告',
    body: [detail, plan.text, '此为第三方记录的预告；时间可能仅为截止时间，不保证届时到账。',
      '来源：codex-resets.com'].filter(Boolean).join('\n').slice(0, 1400),
    url: plan.url
  };
}

/** Injectable dependencies allow offline integration tests without contacting Bark. */
export async function runMonitor({
  fetchImpl = fetch, sleep, statePath = DEFAULT_STATE,
  serverUrl = process.env.SERVER_URL, deviceKey = process.env.DEVICE_KEY,
  timeZone = process.env.TIME_ZONE || 'Asia/Shanghai', logger = console,
  testPush = false
} = {}) {
  if (!serverUrl || !deviceKey) throw new Error('请设置 SERVER_URL 和 DEVICE_KEY');
  // Fail early on malformed timezone rather than failing after a push succeeded.
  new Intl.DateTimeFormat('zh-CN', { timeZone });
  const send = async (msg) => pushBark({ serverUrl, deviceKey, ...msg, fetchImpl, sleep });

  if (testPush) {
    await send({
      title: 'Codex Resets 监控测试',
      body: 'Bark 通道连接成功。此操作不更新监控状态。', url: SOURCE
    });
    logger.info('Bark 测试推送成功（状态未变更）');
    return { testPush: true };
  }

  // Fetch both successfully before any state changes or notifications.
  const [statusPayload, historyPayload] = await Promise.all([
    requestJson(STATUS_API, { fetchImpl, sleep }),
    requestJson(HISTORY_API, { fetchImpl, sleep })
  ]);
  const currentPlan = normalizePlan(statusPayload);
  const currentItems = normalizeAnnouncements(historyPayload);
  let state = await readState(statePath);
  if (!state) {
    state = { version: 1, seenIds: currentItems.map((item) => item.id), plan: currentPlan };
    await saveState(statePath, state);
    logger.info(`首次初始化：保存 ${state.seenIds.length} 条公告及当前计划，不发送历史通知`);
    return { initialized: true };
  }

  const seen = new Set(state.seenIds);
  const newItems = currentItems.filter((item) => !seen.has(item.id)).reverse();
  let sent = 0;
  for (const item of newItems) {
    await send(announcementMessage(item, timeZone));
    // Checkpoint immediately: if a later push fails, earlier successful ones stay marked.
    seen.add(item.id);
    state.seenIds.push(item.id);
    await saveState(statePath, state);
    sent++;
    logger.info(`公告已推送并保存：${item.id} (${item.type})`);
  }

  const before = state.plan?.signature || null;
  const after = currentPlan?.signature || null;
  if (before !== after) {
    if (!currentPlan && sent > 0) {
      // A newer reset and disappearing schedule are often the same underlying news.
      logger.info('本次有新公告，预定计划消失不再重复推送（原因仍未确认）');
    } else {
      await send(planMessage(currentPlan, state.plan, timeZone));
      logger.info(`预定计划已推送：${currentPlan ? '新增/更新' : '不再显示'}`);
      sent++;
    }
    state.plan = currentPlan;
    await saveState(statePath, state);
  }
  logger.info(`检查完成：新增公告 ${newItems.length}，发送通知 ${sent}；无变化则不提交 Git`);
  return { initialized: false, sent };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMonitor({ testPush: process.argv.includes('--test-push') }).catch((error) => {
    console.error(`监控失败：${error.message}`);
    process.exitCode = 1;
  });
}
