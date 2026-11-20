function readDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.onabort = () => reject(new Error('Could not read the clipboard image'));
    reader.readAsDataURL(blob);
  });
}

async function toPng(image) {
  const { naturalWidth, naturalHeight } = image;
  if (!naturalWidth || !naturalHeight) throw new Error('The clipboard image has no usable dimensions');

  const canvas = document.createElement('canvas');
  canvas.width = naturalWidth;
  canvas.height = naturalHeight;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not open a canvas for the clipboard image');

    context.drawImage(image, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((png) => {
        if (png) resolve(png);
        else reject(new Error('Could not encode the clipboard image as PNG'));
      }, 'image/png');
    });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function prepareCoverForClipboard(blob, image) {
  const png = blob.type === 'image/png' ? blob : await toPng(image);
  return { png, dataUrl: await readDataUrl(png) };
}

function appendLinkedLine(paragraph, line) {
  let end = 0;
  for (const match of line.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const value = match[0];
    let url;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) continue;

    paragraph.append(line.slice(end, match.index));
    const link = document.createElement('a');
    link.href = value;
    link.textContent = value;
    paragraph.append(link);
    end = match.index + value.length;
  }
  paragraph.append(line.slice(end));
}

function buildRichPost(text, dataUrl) {
  const wrapper = document.createElement('div');
  for (const block of text.replace(/\r\n?/g, '\n').split('\n\n')) {
    const paragraph = document.createElement('p');
    for (const [index, line] of block.split('\n').entries()) {
      if (index) paragraph.append(document.createElement('br'));
      appendLinkedLine(paragraph, line);
    }
    wrapper.append(paragraph);
  }
  const imageBlock = document.createElement('p');
  const image = document.createElement('img');
  image.src = dataUrl;
  image.alt = 'Campaign cover';
  imageBlock.append(image);
  wrapper.append(imageBlock);
  return wrapper.innerHTML;
}

export async function copyTextAndCover(text, { png, dataUrl }) {
  return navigator.clipboard.write([new ClipboardItem({
    'text/html': new Blob([buildRichPost(text, dataUrl)], { type: 'text/html' }),
    'image/png': png,
    'text/plain': new Blob([text], { type: 'text/plain' }),
  })]);
}

export async function copyCover({ png }) {
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
