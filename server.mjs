import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 38765);
const origin = `http://${host}:${port}`;
const openOnStart = process.argv.includes('--open');
const taskOnEndpoint = 'https://api.taskon.xyz/v1/getCampaignInfo';
const coverHosts = new Set(['img.taskon.xyz', 'static.taskon.xyz']);
const coverTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const coverUrls = new Map();
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/post.mjs', ['post.mjs', 'text/javascript; charset=utf-8']],
  ['/clipboard.mjs', ['clipboard.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const rewardFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 });

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function safeCover(value) {
  if (typeof value !== 'string' || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !coverHosts.has(url.hostname)) {
    return null;
  }
  return url;
}

function timestamp(value) {
  const milliseconds = Number(value);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 8.64e15
    ? milliseconds
    : null;
}

function getStatus(campaign, startTime, endTime, now = Date.now()) {
  if (campaign.is_end || campaign.campaign_status === 'Ended' || (endTime !== null && now >= endTime)) {
    return 'ended';
  }
  if (startTime !== null && now < startTime) return 'upcoming';
  if (campaign.campaign_status === 'OnGoing' || (startTime !== null && endTime !== null)) return 'active';
  return 'unknown';
}

function summarizeRewards(rows) {
  if (!Array.isArray(rows)) return '';
  const rewards = [];
  for (const row of rows) {
    const amount = String(row?.reward_amount ?? '').trim();
    const symbol = typeof row?.reward_symbol === 'string' ? row.reward_symbol.trim() : '';
    if (symbol && /^\d+(?:\.\d+)?$/.test(amount) && Number(amount) > 0) {
      rewards.push(`${rewardFormatter.format(amount)} ${symbol}`);
    }
  }
  return rewards.join(' + ');
}

async function readBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Upstream body exceeds the size limit');
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('Upstream body exceeds the size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function getCampaign(id) {
  let payload;
  try {
    const upstream = await fetch(taskOnEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: Number(id) }),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      if (upstream.status === 404) throw new RequestError(404, '这个 TaskOn 活动无法访问，可以手动补填。');
      throw new Error(`TaskOn returned HTTP ${upstream.status}`);
    }
    payload = JSON.parse(await readBody(upstream, 24 * 1024 * 1024));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new RequestError(504, '读取 TaskOn 活动超时，可以重试或手动补填。');
    }
    throw new RequestError(502, '暂时无法读取 TaskOn 活动，请检查网络，或手动补填。');
  }

  const campaign = payload?.result;
  if (payload?.error?.code === 'CAMPAIGN_NOT_EXIST' || campaign?.is_draft || campaign?.is_removed) {
    throw new RequestError(404, '这个 TaskOn 活动无法访问，可以手动补填。');
  }
  if (payload?.error || String(campaign?.id) !== id || typeof campaign.name !== 'string' || !campaign.name.trim()) {
    throw new RequestError(502, 'TaskOn 未返回可用的活动信息，可以手动补填。');
  }
  coverUrls.delete(id);
  coverUrls.set(id, safeCover(campaign.image));
  if (coverUrls.size > 32) coverUrls.delete(coverUrls.keys().next().value);
  return campaign;
}

function toQuest(campaign, id) {
  const startTime = timestamp(campaign.start_time);
  const endTime = timestamp(campaign.end_time);
  return {
    id,
    title: campaign.name.trim(),
    organizer: typeof campaign.community_name === 'string' ? campaign.community_name.trim() : '',
    rewards: summarizeRewards(campaign.winner_rewards_simple),
    startTime,
    endTime,
    status: getStatus(campaign, startTime, endTime),
    coverUrl: coverUrls.get(id) ? `/api/quests/${id}/cover` : '',
  };
}

async function getCover(id) {
  if (!coverUrls.has(id)) await getCampaign(id);
  const url = coverUrls.get(id);
  if (!url) throw new RequestError(404, '这个活动没有可下载的官方封面，可以上传图片。');

  try {
    const upstream = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    const type = upstream.headers.get('content-type')?.split(';')[0].toLowerCase();
    if (!upstream.ok || !coverTypes.has(type)) {
      await upstream.body?.cancel();
      throw new Error('Upstream did not return a supported image');
    }
    const bytes = await readBody(upstream, 16 * 1024 * 1024);
    if (!bytes.length) throw new Error('Upstream returned an empty image');
    return { bytes, type };
  } catch {
    throw new RequestError(502, '官方封面加载失败，可以上传图片。');
  }
}

function send(response, status, content, contentType) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(content),
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    'X-TaskOn-Post-Generator': '1',
  });
  response.end(content);
}

function sendJson(response, status, result) {
  send(response, status, JSON.stringify(result), 'application/json; charset=utf-8');
}

async function handle(request, response) {
  if (request.headers.host !== `${host}:${port}` || (request.headers.origin && request.headers.origin !== origin)) {
    throw new RequestError(403, '请从本机地址打开工具。');
  }
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    throw new RequestError(405, '不支持此请求方式。');
  }
  const path = request.url.split('?')[0];
  const staticFile = staticFiles.get(path);
  if (staticFile) {
    const [filename, contentType] = staticFile;
    const content = await readFile(new URL(`./public/${filename}`, import.meta.url));
    send(response, 200, content, contentType);
    return;
  }

  const match = /^\/api\/quests\/([1-9]\d*)(\/cover)?$/.exec(path);
  if (match) {
    const [, id, cover] = match;
    if (!Number.isSafeInteger(Number(id))) throw new RequestError(400, '活动编号无效。');

    if (cover) {
      const { bytes, type } = await getCover(id);
      send(response, 200, bytes, type);
    } else {
      const campaign = await getCampaign(id);
      sendJson(response, 200, toQuest(campaign, id));
    }
    return;
  }

  if (path.startsWith('/api/quests/')) throw new RequestError(400, '活动编号无效。');
  throw new RequestError(404, '页面不存在。');
}

function openBrowser() {
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '""', origin], {
      stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
    })
    : spawn('/usr/bin/open', [origin], { stdio: 'ignore' });
  const showAddress = () => console.log(`请在浏览器打开 ${origin}`);
  child.once('error', showAddress);
  child.once('exit', code => { if (code) showAddress(); });
  child.unref();
}

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('PORT 无效，请使用 1–65535 之间的端口。');
  process.exit(1);
}

const server = createServer(async (request, response) => {
  try {
    await handle(request, response);
  } catch (error) {
    if (error instanceof RequestError) {
      sendJson(response, error.status, { error: error.message });
    } else {
      console.error(error);
      sendJson(response, 500, { error: '本地工具暂时无法完成此请求。' });
    }
  }
});

server.once('error', async error => {
  if (openOnStart && error.code === 'EADDRINUSE') {
    const existing = await fetch(origin, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (existing?.ok && existing.headers.get('X-TaskOn-Post-Generator') === '1') {
      await existing.body?.cancel();
      openBrowser();
      return;
    }
    await existing?.body?.cancel();
  }
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : `启动失败，${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`TaskOn 社群帖生成器已启动\n${origin}\n使用期间请保留此窗口。`);
  if (openOnStart) openBrowser();
});
