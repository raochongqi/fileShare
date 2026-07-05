/**
 * 文件图标映射模块
 *
 * 根据文件扩展名或是否为目录，返回对应的 CSS 类名和内联 SVG 图标。
 * 对外暴露：
 * - getFileIconClass(filename, isDir) — 获取图标 CSS 类名
 * - FILE_ICONS — 图标类名到 SVG 字符串的映射表
 */

// ─── 扩展名 → 图标类别 ────────────────────────────────────────────

/** 图片格式 */
const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff',
]);

/** PDF 格式 */
const PDF_EXTS = new Set(['pdf']);

/** 办公文档格式 */
const DOCUMENT_EXTS = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
]);

/** 纯文本格式 */
const TEXT_EXTS = new Set(['txt', 'md', 'log', 'csv', 'rtf']);

/** 代码 / 标记语言格式 */
const CODE_EXTS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java',
  'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash',
  'html', 'css', 'scss', 'less',
  'json', 'xml', 'yaml', 'yml', 'toml', 'sql',
  'vue', 'svelte',
]);

/** 视频格式 */
const VIDEO_EXTS = new Set([
  'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm',
]);

/** 音频格式 */
const AUDIO_EXTS = new Set([
  'mp3', 'wav', 'flac', 'ogg', 'aac', 'wma', 'm4a',
]);

/** 压缩包 / 镜像格式 */
const ARCHIVE_EXTS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'dmg', 'iso',
]);

// ─── 类别 → 图标类名 ──────────────────────────────────────────────

const CATEGORY_TO_CLASS: Record<string, string> = {
  folder:   'icon-folder',
  image:    'icon-image',
  pdf:      'icon-pdf',
  document: 'icon-document',
  text:     'icon-text',
  code:     'icon-code',
  video:    'icon-video',
  audio:    'icon-audio',
  archive:  'icon-archive',
  default:  'icon-default',
};

// ─── 公开函数 ──────────────────────────────────────────────────────

/**
 * 根据文件名和是否为目录，返回对应的图标 CSS 类名。
 *
 * @param filename - 文件名（含扩展名），例如 "report.pdf"
 * @param isDir    - 是否为目录
 * @returns 图标 CSS 类名，例如 "icon-pdf"、"icon-folder"、"icon-default"
 */
export function getFileIconClass(filename: string, isDir: boolean): string {
  if (isDir) {
    return CATEGORY_TO_CLASS['folder'];
  }

  // 提取最后一个点之后的扩展名（小写）
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === filename.length - 1) {
    return CATEGORY_TO_CLASS['default'];
  }

  const ext = filename.slice(dotIndex + 1).toLowerCase();

  if (IMAGE_EXTS.has(ext))    return CATEGORY_TO_CLASS['image'];
  if (PDF_EXTS.has(ext))      return CATEGORY_TO_CLASS['pdf'];
  if (DOCUMENT_EXTS.has(ext)) return CATEGORY_TO_CLASS['document'];
  if (TEXT_EXTS.has(ext))     return CATEGORY_TO_CLASS['text'];
  if (CODE_EXTS.has(ext))     return CATEGORY_TO_CLASS['code'];
  if (VIDEO_EXTS.has(ext))    return CATEGORY_TO_CLASS['video'];
  if (AUDIO_EXTS.has(ext))    return CATEGORY_TO_CLASS['audio'];
  if (ARCHIVE_EXTS.has(ext))  return CATEGORY_TO_CLASS['archive'];

  return CATEGORY_TO_CLASS['default'];
}

// ─── SVG 图标映射表 ────────────────────────────────────────────────

/**
 * 图标类名 → 内联 SVG 字符串映射表。
 *
 * 所有 SVG 使用 16×16 viewBox，颜色使用 currentColor 以便 CSS 控制填充色。
 * 图标采用简单几何形状，保持视觉一致性。
 */
export const FILE_ICONS: Record<string, string> = {
  /* 文件夹 — 圆角矩形 + 顶部标签 */
  'icon-folder': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.5 3.5h4l1.5 1.5h7.5v8.5H1.5z"/></svg>`,

  /* 图片 — 矩形框 + 山形 + 圆点（太阳） */
  'icon-image': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1"/><circle cx="5" cy="6" r="1.2" fill="currentColor"/><path d="M1.5 11l3.5-3.5 2.5 2.5 2-2L14.5 11"/></svg>`,

  /* PDF — 矩形纸张 + 角折 + "P" 字 */
  'icon-pdf': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/><text x="5.5" y="11.5" font-size="4" fill="currentColor" stroke="none" font-family="sans-serif">P</text></svg>`,

  /* 文档 — 矩形纸张 + 横线 */
  'icon-document': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="5" y1="10" x2="11" y2="10"/></svg>`,

  /* 文本 — 矩形纸张 + 多行横线 */
  'icon-text': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><rect x="2.5" y="1.5" width="11" height="13" rx="1"/><line x1="5" y1="4.5" x2="11" y2="4.5"/><line x1="5" y1="7" x2="11" y2="7"/><line x1="5" y1="9.5" x2="9" y2="9.5"/></svg>`,

  /* 代码 — 尖括号 < /> */
  'icon-code': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,3 1,8 5,13"/><polyline points="11,3 15,8 11,13"/><line x1="9.5" y1="2" x2="6.5" y2="14"/></svg>`,

  /* 视频 — 矩形 + 播放三角 */
  'icon-video': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><rect x="1.5" y="3" width="13" height="10" rx="1"/><polygon points="6.5,5.5 11,8 6.5,10.5" fill="currentColor"/></svg>`,

  /* 音频 — 圆形音符 */
  'icon-audio': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M6 12.5v-8l7-2v8"/><circle cx="4" cy="12.5" r="2" fill="currentColor"/><circle cx="11" cy="10.5" r="2" fill="currentColor"/></svg>`,

  /* 压缩包 — 矩形 + 拉链 */
  'icon-archive': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><rect x="3" y="1.5" width="10" height="13" rx="1"/><line x1="8" y1="1.5" x2="8" y2="7"/><rect x="7" y="4" width="2" height="2" fill="currentColor"/><line x1="8" y1="9" x2="8" y2="14.5"/><rect x="7" y="10" width="2" height="2" fill="currentColor"/></svg>`,

  /* 默认 — 矩形纸张 */
  'icon-default': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/></svg>`,
};
