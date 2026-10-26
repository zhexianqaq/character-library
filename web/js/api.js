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

export const api = {
  get: (url) => req(url),
  post: json('POST'),
  patch: json('PATCH'),
  del: (url) => req(url, { method: 'DELETE' }),

  thumb: (id) => (id ? `/t/${id}` : ''),
  preview: (id) => (id ? `/pv/${id}` : ''),
  original: (id) => `/m/${id}`,

  overview: () => req('/api/overview'),
  createShelf: (name, kind = 'people') => json('POST')('/api/shelves', { name, kind }),
  shelves: () => req('/api/overview').then((d) => d.shelves),

  shelfCharacters: (shelfId, params) => req(`/api/shelves/${shelfId}/characters${qs(params)}`),
  createCharacter: (data) => json('POST')('/api/characters', data),
  character: (id) => req(`/api/characters/${id}`),
  updateCharacter: (id, patch) => json('PATCH')(`/api/characters/${id}`, patch),
  deleteCharacter: (id) => req(`/api/characters/${id}`, { method: 'DELETE' }),

  tags: () => req('/api/tags'),
  packs: (charId) => req(`/api/characters/${charId}/packs`),
  createPack: (charId, data) => json('POST')(`/api/characters/${charId}/packs`, data),
  pack: (id) => req(`/api/packs/${id}`),
  updatePack: (id, patch) => json('PATCH')(`/api/packs/${id}`, patch),
  deletePack: (id) => req(`/api/packs/${id}`, { method: 'DELETE' }),
  packMedia: (id) => req(`/api/packs/${id}/media`),
  characterMedia: (id, params) => req(`/api/characters/${id}/media${qs(params)}`),

  updateMedia: (id, patch) => json('PATCH')(`/api/media/${id}`, patch),
  deleteMedia: (id) => req(`/api/media/${id}`, { method: 'DELETE' }),

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
