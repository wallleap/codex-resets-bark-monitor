const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(header, attempt, now = Date.now()) {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const parsed = Date.parse(header);
    if (Number.isFinite(parsed)) return Math.max(0, parsed - now);
  }
  return attempt === 1 ? 1000 : 3000;
}

/** Bounded retries; never persist or log Bark credentials or request payloads. */
export async function requestJson(url, { method = 'GET', body, fetchImpl = fetch, sleep = wait } = {}) {
  const totalAttempts = 3;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': 'codex-resets-bark-monitor/1.0'
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      if (attempt === totalAttempts) throw new Error('网络请求失败或超时（重试 3 次仍失败）');
      await sleep(retryDelay(null, attempt));
      continue;
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const delay = retryDelay(response.headers?.get('retry-after'), attempt);
      if (retryable && attempt < totalAttempts && delay <= 15000) {
        console.warn(`HTTP ${response.status}，${delay}ms 后重试（${attempt}/${totalAttempts}）`);
        await sleep(delay);
        continue;
      }
      if (response.status === 429 && delay > 15000) {
        throw new Error('HTTP 429：服务器要求较长等待，本次跳过，下个定时周期再试');
      }
      throw new Error(`HTTP ${response.status}（${method} 失败）`);
    }

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('服务器返回的不是有效 JSON');
    }
    // Some Bark gateways report transient failure inside JSON while HTTP is 200.
    const code = Number(result?.code);
    if (method === 'POST' && (code === 429 || code >= 500) && attempt < totalAttempts) {
      const delay = retryDelay(null, attempt);
      console.warn(`Bark 业务错误 ${code}，${delay}ms 后重试（${attempt}/${totalAttempts}）`);
      await sleep(delay);
      continue;
    }
    return result;
  }
  throw new Error('请求失败');
}

export function barkEndpoint(serverUrl) {
  if (!serverUrl) throw new Error('缺少 SERVER_URL 环境变量');
  let parsed;
  try { parsed = new URL(serverUrl); } catch { throw new Error('SERVER_URL 不是合法 URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('SERVER_URL 必须是无账号、查询参数和片段的 HTTPS 地址');
  }
  return `${serverUrl.replace(/\/+$/, '')}/push`;
}

export async function pushBark({ serverUrl, deviceKey, title, body, url, fetchImpl, sleep }) {
  if (!deviceKey?.trim()) throw new Error('缺少 DEVICE_KEY 环境变量');
  const payload = {
    device_key: deviceKey,
    title,
    body,
    group: 'Codex Resets',
    level: 'active',
    ...(url ? { url } : {})
  };
  const result = await requestJson(barkEndpoint(serverUrl), {
    method: 'POST', body: payload, fetchImpl, sleep
  });
  // Bark v2 reports code=200 on success, even when the HTTP status itself is 200.
  if (!result || typeof result !== 'object' || Number(result.code) !== 200) {
    throw new Error('Bark 响应未确认推送成功（期望 code=200）');
  }
}
