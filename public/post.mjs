const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const UTC_PLUS_EIGHT = 8 * HOUR;
const X_HOSTS = new Set([
  'x.com', 'www.x.com', 'mobile.x.com',
  'twitter.com', 'www.twitter.com', 'mobile.twitter.com',
]);
const RESERVED_X_PROFILES = new Set([
  'account', 'compose', 'explore', 'home', 'i', 'intent', 'login', 'logout',
  'messages', 'notifications', 'privacy', 'search', 'settings', 'share', 'signup', 'tos',
]);
const POST_ACTIONS = {
  like: 'Like this post on X',
  repost: 'Repost on X',
  quote: 'Quote this post on X',
  reply: 'Reply to this post on X',
};
const CAMPAIGN_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Etc/GMT-8',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function parseHttpsUrl(value) {
  if (!/^https:\/\/[^/]/i.test(value) || /[\s\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password || url.port ? null : url;
  } catch {
    return null;
  }
}

export function parseQuestUrl(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  const url = parseHttpsUrl(value);
  if (url?.hostname !== 'taskon.xyz') return null;

  const match = /^\/quest\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
  return { id: match[1], url: value };
}

function validTime(timestamp) {
  return typeof timestamp === 'number' && Number.isFinite(new Date(timestamp).getTime());
}

export function getCampaignStatus(campaign, now = Date.now()) {
  const { startTime, endTime, status } = campaign;
  if (status === 'ended' || (validTime(endTime) && endTime <= now)) return 'ended';
  if (validTime(startTime) && startTime > now) return 'upcoming';
  if (validTime(startTime) || status === 'active') return 'active';
  if (status === 'upcoming') return 'upcoming';
  return validTime(endTime) ? 'active' : 'unknown';
}

export function formatManualDate(timestamp) {
  if (!validTime(timestamp) || !validTime(timestamp + UTC_PLUS_EIGHT)) return '';
  const local = new Date(timestamp + UTC_PLUS_EIGHT).toISOString();
  return local.slice(17, 19) === '00' ? local.slice(0, 16) : local.slice(0, 19);
}

export function parseManualDate(input) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(input)) return null;
  const timestamp = Date.parse(`${input}+08:00`);
  if (!validTime(timestamp)) return null;

  const local = new Date(timestamp + UTC_PLUS_EIGHT).toISOString();
  return local.startsWith(input) ? timestamp : null;
}

export function formatCampaignTime(timestamp) {
  const local = formatManualDate(timestamp);
  return local ? `${CAMPAIGN_DATE.format(timestamp)} at ${local.slice(11)} (UTC+8)` : '';
}

function profileLink(target) {
  const handle = /^@([a-z0-9_]{1,15})$/i.exec(target);
  if (handle) return RESERVED_X_PROFILES.has(handle[1].toLowerCase()) ? '' : `https://x.com/${handle[1]}`;

  const url = parseHttpsUrl(target);
  if (!url || !X_HOSTS.has(url.hostname)) return '';
  const match = /^\/([a-z0-9_]{1,15})\/?$/i.exec(url.pathname);
  return match && !RESERVED_X_PROFILES.has(match[1].toLowerCase()) ? target : '';
}

function isPostLink(target) {
  const url = parseHttpsUrl(target);
  return Boolean(url && X_HOSTS.has(url.hostname)
    && /^\/(?:[a-z0-9_]{1,15}|i\/web)\/status\/[1-9]\d*\/?$/i.test(url.pathname));
}

export function validateTask(task) {
  const { type, details = '' } = task;
  const target = (task.target ?? '').trim();
  const hasDetails = Boolean(details.trim());
  const result = { line: '', error: '' };
  if (!target && !hasDetails) return result;

  switch (type) {
    case 'follow': {
      const link = profileLink(target);
      if (link) result.line = `Follow on X: ${link}`;
      else result.error = '请输入 X 的 @账号或主页链接。';
      break;
    }
    case 'like':
    case 'repost':
    case 'quote':
    case 'reply':
      if (isPostLink(target)) result.line = `${POST_ACTIONS[type]}: ${target}`;
      else result.error = '请输入具体的 X 推文链接（包含 /status/ 和帖子编号）。';
      break;
    case 'publish':
      if (hasDetails) result.line = `Post on X:\n${details}`;
      else result.error = '请输入要发布的内容。';
      break;
    case 'other':
      if (!hasDetails) result.error = '请填写操作说明。';
      else if (target && !parseHttpsUrl(target)) result.error = '请输入有效的 HTTPS 公开链接。';
      else result.line = target ? `${details}\n${target}` : details;
      break;
    default:
      result.error = '请选择 X 任务类型。';
  }

  if (result.line && hasDetails && type !== 'publish' && type !== 'other') {
    result.line += `\n${details}`;
  }
  return result;
}

function formatCountdown(remaining) {
  if (remaining < HOUR) return 'Less than an hour left';
  const unit = remaining >= DAY ? 'day' : 'hour';
  const count = Math.ceil(remaining / (unit === 'day' ? DAY : HOUR));
  return `Only ${count} ${unit}${count === 1 ? '' : 's'} left`;
}

function scheduleLine(campaign, status, now) {
  if (status === 'upcoming') {
    const start = formatCampaignTime(campaign.startTime);
    return start ? `⏰ Starts ${start}` : '';
  }

  const end = formatCampaignTime(campaign.endTime);
  if (status === 'ended') return end ? `⏰ Campaign ended ${end}` : '⏰ Campaign ended';
  if (status !== 'active' || !end) return '';

  const remaining = campaign.endTime - now;
  if (remaining <= 3 * DAY) return `⏰ ${formatCountdown(remaining)} before the campaign ends!`;
  return `⏰ Ends ${end}`;
}

function campaignHeadline(campaign) {
  const organizer = campaign.organizer?.trim();
  if (!organizer) return campaign.title?.trim() || 'TaskOn Quest';
  return /^(?:TaskOn)$|\s[x×]\s+TaskOn$/i.test(organizer) ? organizer : `${organizer} x TaskOn`;
}

export function generatePost(campaign, now = Date.now()) {
  const status = getCampaignStatus(campaign, now);
  const rewards = campaign.rewards?.trim();
  const blocks = [`🤑 ${campaignHeadline(campaign)}`];

  const schedule = scheduleLine(campaign, status, now);
  if (schedule) blocks.push(schedule);
  if (rewards) blocks.push(`🎁 Rewards: ${rewards}`);

  if (status === 'active') {
    blocks.push(rewards
      ? "Don't miss your chance to participate and grab your share of the rewards!"
      : "Don't miss your chance to participate!");
  }

  if (campaign.url) {
    const action = status === 'active' ? 'Join now' : 'View campaign';
    blocks.push(`👉 ${action}: ${campaign.url}`);
  }
  return blocks.join('\n\n');
}
