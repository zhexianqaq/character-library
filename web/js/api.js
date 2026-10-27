async function req(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch {
      /* 非 JSON */
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

const json = (method) => (url, body) =>
  req(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

const qs = (params) => {
  const s = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') s.set(k, v);
  });
  const str = s.toString();
  return str ? `?${str}` : '';
};

/**
 * 换过封面的视频：
 *
 * 浏览器在同一份文档里再要同一个图片 URL 时，会直接用内存里那张，
 * 就算响应头是 `no-cache` 也不回源（实测：换完封面回列表还是旧图）。
 * 所以换封面后把这个 id 的版本号抬一下，之后 `api.thumb()` 拼出来的 URL 就变了。
 * 整个文档重新加载后表是空的，走服务端 ETag 回源，同样拿得到新图。
 */
const thumbBumps = new Map();

export const api = {
  get: (url) => req(url),
  post: json('POST'),
  patch: json('PATCH'),
  del: (url) => req(url, { method: 'DELETE' }),

  thumb: (id) => {
    if (!id) return '';
    const v = thumbBumps.get(Number(id));
    return v ? `/t/${id}?v=${v}` : `/t/${id}`;
  },
  /** 封面变了就抬版本号，让所有用到这张缩略图的地方都换 URL */
  bumpThumb: (id) => {
    if (id) thumbBumps.set(Number(id), Date.now());
  },
  preview: (id) => (id ? `/pv/${id}` : ''),
  original: (id) => `/m/${id}`,

  overview: () => req('/api/overview'),
  createShelf: (name, kind = 'people', extra = {}) => json('POST')('/api/shelves', { name, kind, ...extra }),
  shelves: () => req('/api/overview').then((d) => d.shelves),

  shelfCharacters: (shelfId, params) => req(`/api/shelves/${shelfId}/characters${qs(params)}`),
  novelShelf: (shelfId, params) => req(`/api/shelves/${shelfId}/novel${qs(params)}`),
  emojiShelf: (shelfId) => req(`/api/shelves/${shelfId}/emoji`),
  resources: (shelfId) => req(`/api/shelves/${shelfId}/resources`),
  resource: (id) => req(`/api/resources/${id}`),
  resourceIndex: () => req('/api/resources/index'),
  ensureResource: (name, category) => json('POST')('/api/resources/ensure', { name, category }),
  createCharacter: (data) => json('POST')('/api/characters', data),
  character: (id) => req(`/api/characters/${id}`),
  updateCharacter: (id, patch) => json('PATCH')(`/api/characters/${id}`, patch),
  deleteCharacter: (id) => req(`/api/characters/${id}`, { method: 'DELETE' }),

  tags: () => req('/api/tags'),
  reveal: (kind, id) => json('POST')('/api/reveal', { kind, id }),
  packs: (charId) => req(`/api/characters/${charId}/packs`),
  createPack: (charId, data) => json('POST')(`/api/characters/${charId}/packs`, data),
  pack: (id) => req(`/api/packs/${id}`),
  updatePack: (id, patch) => json('PATCH')(`/api/packs/${id}`, patch),
  deletePack: (id, { withMedia = false } = {}) =>
    req(`/api/packs/${id}${withMedia ? '?withMedia=1' : ''}`, { method: 'DELETE' }),
  packMedia: (id) => req(`/api/packs/${id}/media`),
  addMediaToPack: (packId, ids) => json('POST')(`/api/packs/${packId}/media`, { ids }),
  pickMedia: (params) => req(`/api/media/pick${qs(params)}`),
  characterMedia: (id, params) => req(`/api/characters/${id}/media${qs(params)}`),

  media: (id) => req(`/api/media/${id}`),
  updateMedia: (id, patch) => json('PATCH')(`/api/media/${id}`, patch),
  bulkMedia: (ids, action, packId) => json('POST')('/api/media/bulk', { ids, action, packId }),
  bulkPacks: (ids, action) => json('POST')('/api/packs/bulk', { ids, action }),
  deleteMedia: (id) => req(`/api/media/${id}`, { method: 'DELETE' }),
  // 视频封面：把第 at 秒那一帧存成缩略图；恢复默认就是删掉它
  setVideoPoster: (id, at) => json('POST')(`/api/media/${id}/poster`, { at }),
  resetVideoPoster: (id) => req(`/api/media/${id}/poster`, { method: 'DELETE' }),

  warm: () => json('POST')('/api/warm', {}),
  tasks: () => req('/api/tasks'),
};

/** 大文件上传走 XHR，才能拿到进度 */
export function uploadMedia(charId, files, { packId = null, category = null, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    if (packId) form.append('packId', String(packId));
    if (category) form.append('category', category);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/characters/${charId}/media`);
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('返回内容无法解析'));
        }
      } else {
        let msg = `上传失败 ${xhr.status}`;
        try {
          const j = JSON.parse(xhr.responseText);
          if (j.error) msg = j.error;
        } catch {
          /* ignore */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误，上传中断'));
    xhr.send(form);
  });
}
