import {
  formatManualDate,
  generatePost,
  getCampaignStatus,
  parseManualDate,
  parseQuestUrl,
  validateTask,
} from './post.mjs';
import { copyCover, copyTextAndCover, prepareCoverForClipboard } from './clipboard.mjs';

const SAMPLE = 'https://taskon.xyz/quest/87574760';
const STATUS_LABEL = { active: '进行中', upcoming: '未开始', ended: '已结束' };
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const COVER_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif',
};
const IMAGE_LIMIT = 20 * 1024 * 1024;

const byId = (id) => document.getElementById(id);
const questForm = byId('quest-form');
const questUrl = byId('quest-url');
const importButton = byId('import-button');
const importStatus = byId('import-status');
const campaignEditor = byId('campaign-editor');
const campaignFields = [...byId('campaign-fields').querySelectorAll('[data-field]')];
const campaignStatus = byId('campaign-status');
const tasksElement = byId('tasks');
const taskTemplate = byId('task-template');
const postText = byId('post-text');
const copyPost = byId('copy-post');
const copyCombined = byId('copy-combined');
const copyStatus = byId('copy-status');
const restorePost = byId('restore-post');
const coverUpload = byId('cover-upload');
const coverPlaceholder = byId('cover-placeholder');
const coverPlaceholderText = byId('cover-placeholder-text');
const coverFigure = byId('cover-figure');
const coverImage = byId('cover-image');
const coverStatus = byId('cover-status');
const copyCoverButton = byId('copy-cover');
const downloadCover = byId('download-cover');

let campaign = null;
let importController;
let generatedText = '';
let cover = null;
let coverVersion = 0;
let taskSequence = 0;

function feedback(element, message = '', tone = '') {
  element.textContent = message;
  element.dataset.tone = tone;
}

function readTask(row) {
  return {
    type: row.querySelector('.task-type').value,
    target: row.querySelector('.task-target').value,
    details: row.querySelector('.task-details').value,
  };
}

function refreshPost() {
  const hasEdits = postText.value !== generatedText;
  const now = Date.now();
  generatedText = campaign ? generatePost(campaign, now) : '';
  if (!hasEdits && postText.value !== generatedText) postText.value = generatedText;

  const status = campaign ? getCampaignStatus(campaign, now) : 'unknown';
  campaignStatus.textContent = STATUS_LABEL[status] ?? '';
  campaignStatus.hidden = !STATUS_LABEL[status];
  campaignStatus.dataset.status = status;
  updateCopyControls();
}

function updateCopyControls() {
  const hasText = Boolean(postText.value.trim());
  const hasClipboardImage = Boolean(cover?.clipboard);
  copyPost.disabled = !hasText;
  copyCombined.disabled = !hasText || !hasClipboardImage;
  copyCoverButton.disabled = !hasClipboardImage;
  restorePost.hidden = !generatedText || generatedText === postText.value;
}

function fillCampaignFields() {
  for (const input of campaignFields) {
    const value = campaign[input.dataset.field];
    input.value = input.type === 'datetime-local' ? formatManualDate(value) : value ?? '';
  }
}

function renderCover(placeholder = '可手动上传活动配图') {
  coverPlaceholderText.textContent = placeholder;
  coverPlaceholder.hidden = Boolean(cover);
  coverFigure.hidden = !cover;
  downloadCover.disabled = !cover;
  if (cover) coverImage.src = cover.url;
  else coverImage.removeAttribute('src');
  updateCopyControls();
}

function clearCover(placeholder) {
  coverVersion += 1;
  if (cover) URL.revokeObjectURL(cover.url);
  cover = null;
  feedback(coverStatus);
  renderCover(placeholder);
}

async function useCover(blob, name, source, version) {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;

  try {
    await image.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  if (version !== coverVersion) {
    URL.revokeObjectURL(url);
    return;
  }
  if (cover) URL.revokeObjectURL(cover.url);
  const nextCover = { url, name, source, clipboard: null };
  cover = nextCover;
  renderCover();
  feedback(coverStatus, source === 'official' ? '官方封面' : `已上传 ${name}`);
  try {
    const prepared = await prepareCoverForClipboard(blob, image);
    if (cover !== nextCover) return;
    cover.clipboard = prepared;
    updateCopyControls();
  } catch {
    if (cover === nextCover) feedback(coverStatus, '图片可下载。剪贴板格式转换失败。', 'error');
  }
}

async function importCover({ id, coverUrl }) {
  if (cover?.source === 'upload') return;
  clearCover(coverUrl ? '正在读取官方封面…' : '活动暂无官方封面，可以上传图片');
  if (!coverUrl) return;

  const version = coverVersion;
  try {
    const response = await fetch(coverUrl);
    if (!response.ok) throw new Error('Cover could not be fetched');
    const blob = await response.blob();
    const extension = COVER_EXTENSIONS[blob.type];
    if (!extension) throw new Error('Unsupported cover type');
    await useCover(blob, `taskon-${id}-cover.${extension}`, 'official', version);
  } catch {
    if (version !== coverVersion) return;
    renderCover();
    feedback(coverStatus, '官方封面加载失败，可以上传图片。', 'error');
  }
}

async function importCampaign() {
  const link = parseQuestUrl(questUrl.value);
  if (!link) {
    questUrl.setAttribute('aria-invalid', 'true');
    feedback(importStatus, '请输入 https://taskon.xyz/quest/数字 格式的活动链接。', 'error');
    questUrl.focus();
    return;
  }

  importController?.abort();
  const controller = new AbortController();
  importController = controller;
  questUrl.value = link.url;
  questUrl.removeAttribute('aria-invalid');
  if (campaign?.id !== link.id) {
    if (campaign) tasksElement.replaceChildren();
    campaign = { ...link, title: '', organizer: '', rewards: '', startTime: null, endTime: null, status: 'unknown', coverUrl: '' };
    campaignEditor.hidden = true;
    campaignEditor.open = false;
    generatedText = '';
    postText.value = '';
    campaignStatus.hidden = true;
    clearCover('正在读取活动信息…');
  } else {
    campaign.url = link.url;
  }

  updateCopyControls();
  feedback(copyStatus);
  importButton.disabled = true;
  importButton.textContent = '读取中…';
  feedback(importStatus, '正在读取活动信息…');

  try {
    const response = await fetch(`/api/quests/${link.id}`, { signal: controller.signal });
    const data = await response.json();
    if (importController !== controller) return;
    if (!response.ok) {
      feedback(importStatus, data.error || '读取失败，可以手动补填。', 'error');
      campaignEditor.open = true;
      if (!cover) renderCover();
    } else {
      campaign = { ...data, ...link };
      feedback(importStatus, '已导入活动信息', 'success');
      void importCover(campaign);
    }
  } catch {
    if (importController !== controller) return;
    feedback(importStatus, '暂时无法读取活动，可以手动补填。', 'error');
    campaignEditor.open = true;
    if (!cover) renderCover();
  } finally {
    if (importController === controller) {
      importController = undefined;
      importButton.disabled = false;
      importButton.textContent = '生成';
      campaignEditor.hidden = false;
      fillCampaignFields();
      refreshPost();
    }
  }
}

function configureTask(row) {
  const type = row.querySelector('.task-type').value;
  const target = row.querySelector('.task-target');
  const details = row.querySelector('.task-details');
  target.closest('label').hidden = type === 'publish';
  if (type === 'follow') {
    row.querySelector('.target-label').textContent = 'X 账号或主页链接';
    target.placeholder = '@taskonxyz';
  } else if (type === 'other') {
    row.querySelector('.target-label').textContent = '公开链接（选填）';
    target.placeholder = 'https://x.com/…';
  } else {
    row.querySelector('.target-label').textContent = '推文链接';
    target.placeholder = 'https://x.com/用户名/status/…';
  }

  if (type === 'publish') {
    row.querySelector('.details-label').textContent = '指定发帖内容';
    details.placeholder = '粘贴需要发布的原文';
  } else if (type === 'other') {
    row.querySelector('.details-label').textContent = '操作说明';
    details.placeholder = '例如 Join the X community';
  } else {
    row.querySelector('.details-label').textContent = '补充要求（选填）';
    details.placeholder = type === 'quote' ? '例如 Include #Campaign and tag @taskonxyz' : '例如 Add a comment about the campaign';
  }
}

function showTaskError(row, task) {
  const errorElement = row.querySelector('.task-error');
  const { error } = validateTask(task);
  errorElement.textContent = error;
  errorElement.hidden = !error;
  const needsDetails = task.type === 'publish' || (task.type === 'other' && !task.details.trim());
  const fieldWithError = needsDetails ? '.task-details' : '.task-target';
  for (const control of row.querySelectorAll('.task-target, .task-details')) {
    if (error && control.matches(fieldWithError)) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  }
}

function addTask() {
  const row = taskTemplate.content.firstElementChild.cloneNode(true);
  const type = row.querySelector('.task-type');
  const target = row.querySelector('.task-target');
  const details = row.querySelector('.task-details');
  const errorElement = row.querySelector('.task-error');
  errorElement.id = `task-error-${++taskSequence}`;
  target.setAttribute('aria-describedby', errorElement.id);
  details.setAttribute('aria-describedby', errorElement.id);

  let touched = false;
  configureTask(row);
  type.addEventListener('change', () => {
    configureTask(row);
    showTaskError(row, readTask(row));
    refreshPost();
  });
  for (const input of [target, details]) {
    input.addEventListener('input', () => {
      if (touched) showTaskError(row, readTask(row));
      refreshPost();
    });
    input.addEventListener('blur', () => {
      touched = true;
      showTaskError(row, readTask(row));
    });
  }
  row.querySelector('.remove-task').addEventListener('click', () => {
    row.remove();
    refreshPost();
    byId('add-task').focus();
  });
  tasksElement.append(row);
  type.focus();
}

questForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void importCampaign();
});
questUrl.addEventListener('input', () => {
  questUrl.removeAttribute('aria-invalid');
  if (!importController) feedback(importStatus);
});
byId('sample-button').addEventListener('click', () => {
  questUrl.value = SAMPLE;
  void importCampaign();
});
for (const input of campaignFields) {
  input.addEventListener('input', () => {
    campaign[input.dataset.field] = input.type === 'datetime-local' ? parseManualDate(input.value) : input.value;
    refreshPost();
  });
}
byId('add-task').addEventListener('click', addTask);
postText.addEventListener('input', () => {
  feedback(copyStatus);
  updateCopyControls();
});
restorePost.addEventListener('click', () => {
  postText.value = generatedText;
  feedback(copyStatus, '已恢复生成的文案', 'success');
  updateCopyControls();
  postText.focus();
});
copyPost.addEventListener('click', async () => {
  refreshPost();
  try {
    await navigator.clipboard.writeText(postText.value);
    feedback(copyStatus, '已复制文案', 'success');
  } catch {
    postText.focus();
    postText.select();
    if (document.execCommand('copy')) feedback(copyStatus, '已复制文案', 'success');
    else feedback(copyStatus, '文案已选中，可以按 ⌘C 复制。');
  }
});

copyCombined.addEventListener('click', async () => {
  refreshPost();
  if (!cover?.clipboard || !postText.value.trim()) return;
  try {
    await copyTextAndCover(postText.value, cover.clipboard);
    feedback(copyStatus, '已复制图文。粘贴时若只出现一项，可以分开复制。', 'success');
  } catch {
    feedback(copyStatus, '图文复制失败，可以分别复制文案和图片。', 'error');
  }
});

copyCoverButton.addEventListener('click', async () => {
  if (!cover?.clipboard) return;
  try {
    await copyCover(cover.clipboard);
    feedback(coverStatus, '已复制图片', 'success');
  } catch {
    feedback(coverStatus, '图片复制失败，可以下载原图。', 'error');
  }
});

byId('choose-cover').addEventListener('click', () => coverUpload.click());
coverUpload.addEventListener('change', async () => {
  const [file] = coverUpload.files;
  coverUpload.value = '';
  if (!file) return;
  if (!UPLOAD_TYPES.has(file.type) || file.size > IMAGE_LIMIT) {
    feedback(coverStatus, '请选择 20 MB 以内的 PNG、JPEG 或 WebP 图片。', 'error');
    return;
  }
  const version = ++coverVersion;
  try {
    await useCover(file, file.name, 'upload', version);
  } catch {
    if (version !== coverVersion) return;
    renderCover();
    feedback(coverStatus, '无法打开这张图片，请选择其他文件。', 'error');
  }
});
downloadCover.addEventListener('click', () => {
  if (!cover) return;
  const link = document.createElement('a');
  link.href = cover.url;
  link.download = cover.name;
  document.body.append(link);
  link.click();
  link.remove();
});

setInterval(() => {
  if (campaign && !importController) refreshPost();
}, 30_000);
