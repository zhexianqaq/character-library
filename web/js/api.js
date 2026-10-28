/**
 * 总览缓存（库列表 + 每个库的条目数 / 媒体数 / 占用）。
 *
 * 首页渲染要一次，进「收件箱」时总览又要一次 —— 同一屏里打两遍同一个统计接口
 * 没有意义（那个接口每库 5 个子查询）。1.5 秒 TTL 只用来吸收这种「同一轮渲染」，
 * 任何写请求成功后立刻失效，导入 / 删除 / 移动不会读到旧数字。
 */
const OVERVIEW_TTL = 1500;
let overviewCache = null;

export function invalidateOverview() {
  overviewCache = null;
}

async function req(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    let j = null;
    try {
      j = await res.json();
      if (j && j.error) msg = j.error;
    } catch {
      /* 非 JSON */
    }
    const err = new Error(msg);
    err.status = res.status;
    // 带上原始 body：调用方要用结构化信息（比如转换漫画时到底有几个视频）
    if (j && typeof j === 'object') err.body = j;
    throw err;
  }
  // 写操作一律让总览作废：宁可多查一次，也不要显示旧数字
  if (String(opts.method || 'GET').toUpperCase() !== 'GET') invalidateOverview();
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
 */
const thumbBumps = new Map();

/**
 * 缩略图 URL 的版本位 —— 用来作废「浏览器里已经存下的旧图」。
 *
 * `?v=` 这个位置是必须的，不是洁癖：v3.25 之前 `/t/:id` 是按 `immutable` 发的，
 * 浏览器把它永久存下来，**连普通刷新都不回源**。于是「换了视频封面，刷新还是旧图」——
 * 服务端明明已经返回新图（实测 /t/2603 与会话封面 sha1 一致），浏览器就是不问。
 * immutable 一旦落盘，只有换 URL 能让它失效；加了这个参数，所有旧缓存项一次性作废。
 *
 * 什么时候 +1：改了缩略图生成方式、或又出现「同一个 URL 内容会变」的需求时。
 * 代价是浏览器重新拉一遍缩略图（本地库三千多张，几秒钟、一次性）。
 */
const THUMB_REV = 2;

export const api = {
  get: (url) => req(url),
  post: json('POST'),
  patch: json('PATCH'),
  del: (url) => req(url, { method: 'DELETE' }),

  thumb: (id) => {
    if (!id) return '';
    const v = thumbBumps.get(Number(id));
    return `/t/${id}?v=${v || THUMB_REV}`;
  },
  /** 封面变了就抬版本号，让所有用到这张缩略图的地方都换 URL */
  bumpThumb: (id) => {
    if (id) thumbBumps.set(Number(id), Date.now());
  },
  preview: (id) => (id ? `/pv/${id}` : ''),
  /** 正文文件原样读取（txt 用字节流自己判编码，其余浏览器直接打开） */
  raw: (id, download = false) => `/api/media/${id}/raw${download ? '?download=1' : ''}`,
  original: (id) => `/m/${id}`,

  overview: ({ fresh = false } = {}) => {
    if (!fresh && overviewCache && Date.now() - overviewCache.at < OVERVIEW_TTL) {
      return Promise.resolve(overviewCache.data);
    }
    return req('/api/overview').then((data) => {
      overviewCache = { at: Date.now(), data };
      return data;
    });
  },
  createShelf: (name, kind = 'people', extra = {}) => json('POST')('/api/shelves', { name, kind, ...extra }),
  shelves: () => api.overview().then((d) => d.shelves),

  shelfCharacters: (shelfId, params) => req(`/api/shelves/${shelfId}/characters${qs(params)}`),
  /** 磁盘同步：preview 只算不动，run 会移动文件（不删文件） */
  syncPreview: () => req('/api/sync/packs/preview'),
  syncRun: () => json('POST')('/api/sync/packs', {}),
  /** 操作日志：日常走增量（只处理 pending + 待校验），上面的 sync* 留作全量校验 */
  opsSummary: () => req('/api/ops/summary'),
  opsPreview: () => req('/api/ops/preview'),
  opsApply: () => json('POST')('/api/ops/apply', {}),
  opsList: (params) => req(`/api/ops${qs(params)}`),
  opsArchive: (days = 365) => json('POST')('/api/ops/archive', { days }),
  novelShelf: (shelfId, params) => req(`/api/shelves/${shelfId}/novel${qs(params)}`),
  novelBags: (shelfId) => req(`/api/shelves/${shelfId}/novelbags`),
  createNovelBag: (shelfId, title) => json('POST')(`/api/shelves/${shelfId}/novelbags`, { title }),
  emojiShelf: (shelfId) => req(`/api/shelves/${shelfId}/emoji`),
  inboxShelf: (shelfId, params) => req(`/api/shelves/${shelfId}/inbox${qs(params)}`),
  resources: (shelfId) => req(`/api/shelves/${shelfId}/resources`),
  resource: (id) => req(`/api/resources/${id}`),
  // 作品 ↔ 条目：候选（还没关联上的）与批量增删 / 移动关联
  resourceCandidates: (id, q) => req(`/api/resources/${id}/candidates${qs({ q })}`),
  resourceLink: (id, ids, action, targetId) =>
    json('POST')(`/api/resources/${id}/related`, { ids, action, targetId }),
  resourceIndex: () => req('/api/resources/index'),
  ensureResource: (name, category) => json('POST')('/api/resources/ensure', { name, category }),
  createCharacter: (data) => json('POST')('/api/characters', data),
  character: (id) => req(`/api/characters/${id}`),
  updateCharacter: (id, patch) => json('PATCH')(`/api/characters/${id}`, patch),
  deleteCharacter: (id) => req(`/api/characters/${id}`, { method: 'DELETE' }),

  tags: () => req('/api/tags'),
  reveal: (kind, id) => json('POST')('/api/reveal', { kind, id }),
  packs: (charId) => req(`/api/characters/${charId}/packs`),
  /** 别的库里标签带上这个条目名的图包（只读入口） */
  linkedPacks: (charId) => req(`/api/characters/${charId}/linked-packs`),
  createPack: (charId, data) => json('POST')(`/api/characters/${charId}/packs`, data),
  pack: (id) => req(`/api/packs/${id}`),
  updatePack: (id, patch) => json('PATCH')(`/api/packs/${id}`, patch),
  deletePack: (id, { withMedia = false } = {}) =>
    req(`/api/packs/${id}${withMedia ? '?withMedia=1' : ''}`, { method: 'DELETE' }),
  packMedia: (id) => req(`/api/packs/${id}/media`),
  /** 图包 ⇄ 漫画：只改 packs.kind / media.page_no，文件不动 */
  convertPack: (id, to, opts = {}) => json('POST')(`/api/packs/${id}/convert`, { to, ...opts }),
  addMediaToPack: (packId, ids) => json('POST')(`/api/packs/${packId}/media`, { ids }),
  pickMedia: (params) => req(`/api/media/pick${qs(params)}`),
  characterMedia: (id, params) => req(`/api/characters/${id}/media${qs(params)}`),
  /** 单个标签的落地页：条目 / 图包 / 最近 200 个素材 */
  tag: (name) => req(`/api/tags/${encodeURIComponent(name)}`),
  /** 小说正文文件列表（kind='file'） */
  charTexts: (id) => req(`/api/characters/${id}/texts`),

  media: (id) => req(`/api/media/${id}`),
  updateMedia: (id, patch) => json('PATCH')(`/api/media/${id}`, patch),
  bulkMedia: (ids, action, packId) => json('POST')('/api/media/bulk', { ids, action, packId }),
  bulkPacks: (ids, action) => json('POST')('/api/packs/bulk', { ids, action }),
  deleteMedia: (id) => req(`/api/media/${id}`, { method: 'DELETE' }),
  /** 移出库：把素材退回到「收件箱 → 未分发」，文件会搬过去 */
  ejectMedia: (ids) => json('POST')('/api/media/eject', { ids }),
  // 视频封面：把第 at 秒那一帧存成缩略图；恢复默认就是删掉它
  setVideoPoster: (id, at) => json('POST')(`/api/media/${id}/poster`, { at }),
  resetVideoPoster: (id) => req(`/api/media/${id}/poster`, { method: 'DELETE' }),

  warm: () => json('POST')('/api/warm', {}),
  tasks: () => req('/api/tasks'),
};

/** 大文件上传走 XHR，才能拿到进度 */
function sendForm(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // 上传不走 req()，这里手动让总览失效（图包数 / 媒体数 / 占用都变了）
        invalidateOverview();
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('返回内容无法解析'));
        }
      } else {
        let msg = `上传失败 ${xhr.status}`;
        let code = '';
        try {
          const j = JSON.parse(xhr.responseText);
          if (j.error) msg = j.error;
          if (j.code) code = j.code;
        } catch {
          /* ignore */
        }
        const err = new Error(msg);
        if (code) err.code = code;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('网络错误，上传中断'));
    xhr.send(form);
  });
}

export function uploadMedia(charId, files, { packId = null, category = null, onProgress } = {}) {
  const form = new FormData();
  for (const f of files) form.append('files', f, f.name);
  if (packId) form.append('packId', String(packId));
  if (category) form.append('category', category);
  return sendForm(`/api/characters/${charId}/media`, form, onProgress);
}

/**
 * 压缩包上传：服务端解压后按图片 / 视频入库。
 * 带 packId 就进那个图包；不带就按压缩包名新建一个（同名包复用）。
 * 加密包要带 password，没有就回 code='NEED_PASSWORD'，前端弹窗要一次再重传。
 */
export function uploadArchive(charId, file, { packId = null, category = null, password = '', onProgress } = {}) {
  const form = new FormData();
  form.append('archive', file, file.name);
  if (packId) form.append('packId', String(packId));
  if (category) form.append('category', category);
  if (password) form.append('password', password);
  return sendForm(`/api/characters/${charId}/archive`, form, onProgress);
}

/**
 * 桌面壳专用：按本机绝对路径导入。
 * 浏览器拿不到路径，只有壳的 drop 事件能给；`move` 默认 true —— 入库成功才删源文件。
 */
export function importPaths({
  paths,
  charId,
  packId = null,
  category = null,
  password = '',
  passwords = [],
  move = true,
}) {
  return json('POST')('/api/import/paths', { paths, charId, packId, category, password, passwords, move });
}
