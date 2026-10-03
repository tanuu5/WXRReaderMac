#!/usr/bin/env node
/**
 * 書庫 MCP — WXRブログバックアップを Claude Desktop / ChatGPT / Codex から検索・閲覧できるようにするMCPサーバ。
 *
 * - 依存パッケージなし（Node標準ライブラリのみ）
 * - WXR解析とHTML→Markdown変換は macOSアプリ「書庫」(WXRReaderMac) のSwift実装からの移植
 * - ネットワーク送信は一切しない
 * - Claude用の .mcpb（mcpb/）と ChatGPT・Codex用のプラグイン（plugins/shoko-chatgpt/）は、どちらもこのファイルを動かす
 *
 * 読み込み先は次の順で決める。
 *   1. 環境変数 SHOKO_WXR_DIR（.mcpb はインストール時のフォルダ選択UIでこれを設定する）
 *   2. 設定ファイル（plugins/shoko-chatgpt/scripts/configure.command が書く）
 *   3. macOSアプリ「書庫」で最後に開いたフォルダ
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const SERVER_NAME = 'shoko';
const SERVER_VERSION = '1.2.0';

/** 応答できるプロトコル版（新しい順）。クライアントの要求がこの中になければ先頭を返す */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function configPath() {
  if (process.env.SHOKO_CONFIG_PATH) return process.env.SHOKO_CONFIG_PATH;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Shoko', 'mcp-config.json');
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Shoko', 'mcp-config.json');
  }
  return path.join(os.homedir(), '.config', 'shoko', 'mcp-config.json');
}

function readConfiguredDir() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return typeof config.wxr_dir === 'string' ? config.wxr_dir.trim() : '';
  } catch {
    return '';
  }
}

/** 書庫アプリ（com.tanu.wxr-reader）が覚えている前回のフォルダ */
function readAppLastFolder() {
  if (process.platform !== 'darwin') return '';
  try {
    return execFileSync('/usr/bin/defaults', ['read', 'com.tanu.wxr-reader', 'lastFolder'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
  } catch {
    return '';
  }
}

function resolveWxrDir() {
  const candidates = [
    [process.env.SHOKO_WXR_DIR || '', 'environment'],
    [readConfiguredDir(), 'config'],
    [readAppLastFolder(), 'WXRReaderMac'],
  ];
  for (const [value, source] of candidates) {
    if (value) return { dir: path.resolve(value), source };
  }
  return { dir: '', source: 'unset' };
}

const WXR = resolveWxrDir();
const WXR_DIR = WXR.dir;

function log(msg) {
  // stdoutはJSON-RPC専用。ログは必ずstderrへ。
  process.stderr.write(`[shoko] ${msg}\n`);
}

// ---------------------------------------------------------------- WXR解析
// WXRParser.swift の移植。整形式XMLに依存せず、CDATAを考慮した文字列走査で <item> を抽出する。

const TAXONOMY_RE =
  /<category\s+domain="(category|post_tag)"[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/g;
const TAG_STRIP_RE = /<[^>]*>/g;

const NAMED_ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * 実体参照を1回の走査で戻す。順に置き換えると "&amp;lt;" が "<" まで戻ってしまう。
 * 数値参照（&#8217; &#x27; など）も戻す。残すと本文に生のまま出て、検索にも掛からない。
 */
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function unwrapCDATA(t) {
  const i = t.indexOf('<![CDATA[');
  if (i < 0) return t;
  const j = t.lastIndexOf(']]>');
  if (j < 0 || i + 9 > j) return t;
  return t.slice(i + 9, j);
}

/** <name ...>内容</name> の内容を返す（最初の出現） */
function tagContent(name, s) {
  const a = s.indexOf('<' + name);
  if (a < 0) return null;
  const b = s.indexOf('>', a);
  if (b < 0) return null;
  const c = s.indexOf('</' + name + '>', b + 1);
  if (c < 0) return null;
  return s.slice(b + 1, c).trim();
}

/** 段落などの区切り。ここを空けずに消すと隣の段落の語がくっつき、抜粋が読めず誤一致も起きる */
const BLOCK_BREAK_RE = /<(?:br|\/(?:p|div|li|h[1-6]|blockquote|figure|figcaption|pre|tr|table|ul|ol))\b[^>]*>/gi;

function stripHTML(html) {
  if (!html) return '';
  return decodeEntities(html.replace(BLOCK_BREAK_RE, '\n').replace(TAG_STRIP_RE, ''));
}

function countOccurrences(s, needle) {
  let n = 0, i = 0;
  for (;;) {
    const j = s.indexOf(needle, i);
    if (j < 0) return n;
    n++;
    i = j + needle.length;
  }
}

/**
 * CDATA内の "</item>" を誤検出しないよう、CDATA区間を読み飛ばしながら真の終端を探す。
 * （開閉の数を数える方式だと、本文に "<![CDATA[" という文字列があるだけで以降の記事をすべて落としていた）
 */
function findItemEnd(text, itemBodyStart) {
  let pos = itemBodyStart;
  for (;;) {
    const close = text.indexOf('</item>', pos);
    if (close < 0) return -1;
    const cdata = text.indexOf('<![CDATA[', pos);
    if (cdata < 0 || cdata > close) return close;
    const cdEnd = text.indexOf(']]>', cdata + 9);
    if (cdEnd < 0) return -1;
    pos = cdEnd + 3;
  }
}

function contentEncoded(item) {
  let a = item.indexOf('<content:encoded>');
  if (a < 0) return '';
  a += '<content:encoded>'.length;
  const cdOpen = item.indexOf('<![CDATA[', a);
  if (cdOpen >= 0) {
    const cdClose = item.indexOf(']]></content:encoded>', cdOpen + 9);
    if (cdClose >= 0) return item.slice(cdOpen + 9, cdClose);
  }
  const close = item.indexOf('</content:encoded>', a);
  if (close >= 0) return unwrapCDATA(item.slice(a, close));
  return '';
}

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/**
 * 日付を YYYY-MM-DD で返す。
 * タイムゾーン変換で日付がずれないよう、Dateを介さず文字列から直接取り出す。
 */
function parseDate(postDate, pubDate) {
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(postDate || '');
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/.exec(pubDate || '');
  if (m && MONTHS[m[2]]) return `${m[3]}-${MONTHS[m[2]]}-${String(m[1]).padStart(2, '0')}`;
  return null;
}

/**
 * 表記ゆれを吸収する。NFKCで全角英数→半角、半角カナ→全角に寄せる。
 * 「ＡＩ」と「AI」、「ｻｰﾊﾞ」と「サーバ」が別語になるのを防ぐ。
 * 大文字小文字の畳み込みは別（表示用に元の字面を残すため）。
 */
function normalizeText(s) {
  return (s || '').normalize('NFKC');
}

function parseItem(item, sourceFile) {
  // noteのタイトルはCDATAの中でさらにHTMLエスケープされている。
  // 実体参照を戻さないと &quot; がそのまま表示され、検索にも引っかからない。
  const title = decodeEntities(unwrapCDATA(tagContent('title', item) || ''));
  const link = unwrapCDATA(tagContent('link', item) || '');
  const pubDate = tagContent('pubDate', item) || '';
  const postDate = unwrapCDATA(tagContent('wp:post_date', item) || '');
  const postType = unwrapCDATA(tagContent('wp:post_type', item) || '') || 'post';
  const status = unwrapCDATA(tagContent('wp:status', item) || '') || 'publish';

  const contentHTML = contentEncoded(item);
  // 正規化済みを本文の正とする。小文字化した対はマッチ専用で、
  // 長さが変わらないので位置がそのまま plain に通用する（スニペットの切り出しに使う）。
  const plain = normalizeText(stripHTML(contentHTML));

  const categories = [], tags = [];
  TAXONOMY_RE.lastIndex = 0;
  let m;
  while ((m = TAXONOMY_RE.exec(item)) !== null) {
    const name = m[2].trim();
    if (!name) continue;
    (m[1] === 'category' ? categories : tags).push(name);
  }

  return {
    title,
    link,
    date: parseDate(postDate, pubDate),
    postType,
    status,
    excerpt: plain.slice(0, 400).trim(),
    contentHTML,
    plain,
    wordCount: plain.replace(/\n/g, '').length,
    categories,
    tags,
    sourceFile,
    titleLower: normalizeText(title).toLowerCase(),
    plainLower: plain.toLowerCase(),
    taxLower: normalizeText(categories.join(' ') + ' ' + tags.join(' ')).toLowerCase(),
    titleTokens: null, // 関連記事の計算で初めて使うとき生成して持ち回す
  };
}

function parseWXR(text, sourceFile) {
  const articles = [];
  let channelTitle = null;
  let pos = 0;
  for (;;) {
    const openAt = text.indexOf('<item>', pos);
    if (openAt < 0) break;
    if (channelTitle === null && articles.length === 0) {
      const ct = tagContent('title', text.slice(0, openAt));
      channelTitle = ct ? unwrapCDATA(ct) : null;
    }
    const closeAt = findItemEnd(text, openAt + 6);
    if (closeAt < 0) break;
    articles.push(parseItem(text.slice(openAt, closeAt + 7), sourceFile));
    pos = closeAt + 7;
  }
  return { channelTitle, articles };
}

// ---------------------------------------------------------------- HTML → Markdown
// HTMLToMarkdown.swift の移植。

function rsub(s, pattern, fn) {
  return s.replace(new RegExp(pattern, 'gis'), fn);
}

function htmlToMarkdown(html, title, date) {
  let md = '';
  if (title) md += `# ${title}\n\n`;
  if (date) md += `> ${date}\n\n---\n\n`;

  let b = html || '';
  for (let level = 1; level <= 5; level++) {
    const h = '#'.repeat(level);
    b = rsub(b, `<h${level}\\b[^>]*>(.*?)</h${level}>`, (_, x) => `\n${h} ${x.trim()}\n\n`);
  }
  b = rsub(b, '<strong\\b[^>]*>(.*?)</strong>', (_, x) => `**${x}**`);
  b = rsub(b, '<b\\b[^>]*>(.*?)</b>', (_, x) => `**${x}**`);
  b = rsub(b, '<em\\b[^>]*>(.*?)</em>', (_, x) => `*${x}*`);
  b = rsub(b, '<i\\b[^>]*>(.*?)</i>', (_, x) => `*${x}*`);
  b = rsub(b, '<del\\b[^>]*>(.*?)</del>', (_, x) => `~~${x}~~`);
  b = rsub(b, '<a\\b[^>]*href="([^"]*)"[^>]*>(.*?)</a>', (_, href, x) => `[${x}](${href})`);
  b = rsub(b, '<img\\b[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*/?>', (_, src, alt) => `![${alt}](${src})`);
  b = rsub(b, '<img\\b[^>]*src="([^"]*)"[^>]*/?>', (_, src) => `![](${src})`);
  b = rsub(b, '<figure\\b[^>]*>(.*?)</figure>', (_, x) => `\n${x}\n`);
  b = rsub(b, '<figcaption\\b[^>]*>(.*?)</figcaption>', (_, x) => `*${x}*\n`);
  b = rsub(b, '<li\\b[^>]*>(.*?)</li>', (_, x) => `- ${x}\n`);
  b = rsub(b, '</?[uo]l\\b[^>]*>', () => '\n');
  b = rsub(b, '<blockquote\\b[^>]*>(.*?)</blockquote>',
    (_, x) => x.trim().split('\n').map((ln) => '> ' + ln.trim()).join('\n') + '\n\n');
  b = rsub(b, '<pre\\b[^>]*><code[^>]*>(.*?)</code></pre>', (_, x) => `\n\`\`\`\n${x}\n\`\`\`\n\n`);
  b = rsub(b, '<pre\\b[^>]*>(.*?)</pre>', (_, x) => `\n\`\`\`\n${x}\n\`\`\`\n\n`);
  b = rsub(b, '<code\\b[^>]*>(.*?)</code>', (_, x) => `\`${x}\``);
  b = rsub(b, '<br\\s*/?>', () => '\n');
  b = rsub(b, '<p\\b[^>]*>(.*?)</p>', (_, x) => `${x}\n\n`);
  b = rsub(b, '<hr\\b[^>]*/?>', () => '\n---\n\n');
  b = rsub(b, '<div\\b[^>]*>(.*?)</div>', (_, x) => `${x}\n`);
  b = rsub(b, '<iframe\\b[^>]*src="([^"]*)"[^>]*>.*?</iframe>', (_, src) => `\n[埋め込み](${src})\n`);
  b = rsub(b, '<[^>]*>', () => '');

  b = decodeEntities(b).replace(/\n{3,}/g, '\n\n').trim();
  return md + b + '\n';
}

// ---------------------------------------------------------------- 蔵書の読み込み
// バックアップは月イチ程度でごっそり入れ替わる想定なので、ファイルの更新時刻と
// サイズを毎回照合し、変わっていれば黙って読み直す。利用者側の操作は不要。

const library = {
  fingerprint: null,
  channelTitle: '',
  articles: [],
  loadedAt: null,
};

function collectXMLs(dir) {
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else if (e.name.toLowerCase().endsWith('.xml')) {
        out.push(p);
      }
    }
  };
  walk(dir, 0);
  return out.sort();
}

function fingerprintOf(files) {
  return files
    .map((f) => {
      try {
        const st = fs.statSync(f);
        return `${f}|${Math.floor(st.mtimeMs)}|${st.size}`;
      } catch {
        return `${f}|missing`;
      }
    })
    .join('\n');
}

class ShokoError extends Error {}

/** UTF-8 を基本に、BOM付き UTF-16 も読む（エディタで保存し直したXMLがこうなることがある） */
function readText(f) {
  const buf = fs.readFileSync(f);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.subarray(2));
    le.swap16();
    return le.toString('utf16le');
  }
  return buf.toString('utf8');
}

/**
 * 記事として扱わない項目。WordPressのエクスポートには画像（attachment）やメニュー、
 * ゴミ箱の記事まで入っている。これらが検索や重複チェックに混ざると、
 * ゴミ箱の記事を根拠に「もう書いています」と答えてしまう。下書きは残す（書いたことには違いない）。
 */
const NON_CONTENT_TYPES = new Set([
  'attachment', 'nav_menu_item', 'revision', 'custom_css', 'customize_changeset',
  'oembed_cache', 'user_request', 'wp_block', 'wp_template', 'wp_template_part',
  'wp_global_styles', 'wp_navigation', 'wp_font_family', 'wp_font_face',
]);
const NON_CONTENT_STATUSES = new Set(['trash', 'auto-draft', 'inherit']);

function isContent(a) {
  return !NON_CONTENT_TYPES.has(a.postType) && !NON_CONTENT_STATUSES.has(a.status);
}

/**
 * 記事id。バックアップを取り直しても同じ記事には同じidが付くよう、リンクから作る。
 * 読み込み順の通し番号だと、ファイルが増えたり並びが変わったりしたとき、
 * 前の検索で得たidが黙って別の記事を指してしまう。
 * （wp:post_id は note ではファイルごとに1から振り直されるので使えない）
 */
function stableId(a, used) {
  const key = a.link || `${a.sourceFile}|${a.date}|${a.title}`;
  let h = 0x811c9dc5; // FNV-1a 32bit
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let id = (h >>> 0) % 1000000000; // 9桁以内に収める
  while (used.has(id)) id = (id + 1) % 1000000000; // 衝突はまず起きないが、起きても重ならないように
  used.add(id);
  return id;
}

/** 必要なら読み直す。呼ぶたびに鮮度を確認するので、呼び出し側は何も考えなくてよい。 */
function ensureLoaded() {
  // フォルダのフルパスはユーザー名を含むので、会話に流れるエラー文には入れない
  if (!WXR_DIR) {
    throw new ShokoError(
      'バックアップフォルダが設定されていません。Claude Desktop なら 設定 → 拡張機能 → 書庫 で、' +
      'ChatGPT・Codex なら書庫アプリで一度フォルダを開くか scripts/configure.command で、' +
      'noteのWXR(.xml)が入っているフォルダを指定してください。'
    );
  }
  if (!fs.existsSync(WXR_DIR)) {
    throw new ShokoError(
      `設定されたバックアップフォルダ（${path.basename(WXR_DIR)}）が見つかりません。フォルダを指定し直してください。`
    );
  }

  const files = collectXMLs(WXR_DIR);
  if (files.length === 0) {
    throw new ShokoError(
      `設定されたフォルダ（${path.basename(WXR_DIR)}）に .xml が見つかりません。` +
      'noteのバックアップzipを展開したフォルダを指定してください。'
    );
  }

  const fp = fingerprintOf(files);
  if (fp === library.fingerprint) return;

  const started = Date.now();
  const articles = [];
  let channelTitle = '';
  const seen = new Set();
  const usedIds = new Set();
  for (const f of files) {
    const base = path.basename(f);
    if (seen.has(base)) continue; // アプリ側と同じくファイル名で重複除去
    seen.add(base);
    let text;
    try {
      text = readText(f);
    } catch (e) {
      log(`読めませんでした: ${base} (${e.message})`);
      continue;
    }
    const r = parseWXR(text, base);
    if (!r.articles.length) log(`${base} から記事を1件も読めませんでした（WXRでないか、文字コードが UTF-8 / UTF-16 以外）`);
    if (!channelTitle && r.channelTitle) channelTitle = r.channelTitle;
    for (const a of r.articles) {
      if (!isContent(a)) continue;
      a.id = stableId(a, usedIds);
      articles.push(a);
    }
  }

  library.fingerprint = fp;
  library.channelTitle = channelTitle;
  library.articles = articles;
  library.loadedAt = new Date().toISOString();
  log(`${files.length}ファイルから${articles.length}件を読み込みました (${Date.now() - started}ms)`);
}

// ---------------------------------------------------------------- 期間指定

/**
 * date_from / date_to を YYYY-MM-DD にそろえる。
 * 記事の日付と文字列で比べるので、"2025-02" のまま date_to に使うと
 * "2025-02-01" が "2025-02" より後と判定され、2月の記事が全部落ちていた。
 * 年・年月だけの指定は、from なら期間の頭、to なら期間の終わりとして扱う。
 */
function normalizeDateArg(v, isEnd, name) {
  if (v === undefined || v === null || v === '') return null;
  const m = /^\s*(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?\s*$/.exec(String(v));
  if (!m) throw new ShokoError(`${name} は YYYY-MM-DD（または YYYY-MM / YYYY）で指定してください: ${v}`);
  const y = m[1];
  const mo = m[2] ? m[2].padStart(2, '0') : (isEnd ? '12' : '01');
  let d = m[3] ? m[3].padStart(2, '0') : null;
  if (!d) d = isEnd ? String(new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate()) : '01';
  return `${y}-${mo}-${d}`;
}

function dateFilter(list, args) {
  const from = normalizeDateArg(args.date_from, false, 'date_from');
  const to = normalizeDateArg(args.date_to, true, 'date_to');
  if (from) list = list.filter((a) => a.date && a.date >= from);
  if (to) list = list.filter((a) => a.date && a.date <= to);
  return list;
}

// ---------------------------------------------------------------- 検索
// AppState.swift と同じ意味論: スペース区切り=AND、単語 OR=OR、部分一致（正規化＋小文字化）

function orGroups(q) {
  return normalizeText(q)
    .split(/\bOR\b/i)
    .map((part) => part.toLowerCase().split(/\s+/).filter(Boolean))
    .filter((g) => g.length > 0);
}

/** 語がこの記事のどこかに現れるか。短いタイトルから見て早く打ち切る。 */
function hasTerm(a, t) {
  return a.titleLower.includes(t) || a.plainLower.includes(t) || a.taxLower.includes(t);
}

/**
 * 語の珍しさ。1008本中491本に出る「Claude」と、10本にしか出ない語を
 * 同じ重みで扱うと、書き手の常用語ばかりが上位に来る。
 */
function idfOf(df, total) {
  return Math.log((total + 1) / (df + 1)) + 0.3;
}

/**
 * 検索語との関連度。
 * - タイトルに出れば大きく加点（記事の主題である可能性が高い）
 * - 本文は出現回数を tf/(tf+2) で頭打ちにする。長文ほど有利、を避けるため
 * - どちらも語のidfを掛ける。珍しい語ほど順位を支配する
 */
function relevanceOf(a, groups, idf) {
  let best = 0;
  for (const g of groups) {
    if (!g.every((t) => hasTerm(a, t))) continue;
    let s = 0;
    for (const t of g) {
      const tf = countOccurrences(a.plainLower, t);
      const inTitle = a.titleLower.includes(t);
      s += idf(t) * ((inTitle ? 3 : 0) + tf / (tf + 2));
    }
    // 複数語がすべてタイトルに揃うのは、まず間違いなくその記事の主題
    if (g.length > 1 && g.every((t) => a.titleLower.includes(t))) s *= 1.2;
    if (s > best) best = s;
  }
  return best;
}

/**
 * 検索語の周辺を切り出す。
 * 最初の1語の初出だけを見ると、常用語（例:「Claude」）が毎回冒頭に出るせいで
 * どの記事も同じリード文が返ってしまう。語がもっとも集まっている窓を選ぶ。
 */
function snippet(a, terms, width = 140) {
  const plain = a.plain;
  if (!terms || !terms.length) return plain.slice(0, width).replace(/\s+/g, ' ');
  const low = a.plainLower;

  // 各語の出現位置（多すぎても意味がないので語ごとに先頭20件まで）
  const hits = [];
  terms.forEach((t, ti) => {
    let i = low.indexOf(t), n = 0;
    while (i >= 0 && n < 20) {
      hits.push({ pos: i, ti });
      i = low.indexOf(t, i + t.length);
      n++;
    }
  });
  if (!hits.length) return plain.slice(0, width).replace(/\s+/g, ' ');
  hits.sort((x, y) => x.pos - y.pos);

  // width内に何種類の語が入るかで窓を選ぶ。同数なら本文の早い方
  let bestStart = hits[0].pos, bestKinds = 0, bestEnd = hits[0].pos;
  for (let i = 0; i < hits.length; i++) {
    const kinds = new Set();
    let j = i;
    while (j < hits.length && hits[j].pos - hits[i].pos <= width) {
      kinds.add(hits[j].ti);
      j++;
    }
    if (kinds.size > bestKinds) {
      bestKinds = kinds.size;
      bestStart = hits[i].pos;
      bestEnd = hits[j - 1].pos;
    }
  }

  const span = bestEnd - bestStart;
  const pad = Math.max(20, Math.floor((width - span) / 2));
  const s = Math.max(0, bestStart - pad);
  const e = Math.min(plain.length, bestEnd + pad);
  return (s > 0 ? '…' : '') + plain.slice(s, e).replace(/\s+/g, ' ') + (e < plain.length ? '…' : '');
}

/**
 * 検索結果の1件。文脈を食わないよう、空の項目と既定値は落とす。
 * 本文はここでは返さない（必要なら get_article）。
 */
function summarize(a, terms) {
  const d = {
    id: a.id,
    title: a.title || '(無題)',
    date: a.date,
    chars: a.wordCount,
  };
  if (a.postType !== 'post') d.post_type = a.postType;
  if (a.status !== 'publish') d.status = a.status; // 下書き（draft）など。公開済みと区別できるように
  if (a.categories.length) d.categories = a.categories;
  if (a.tags.length) d.tags = a.tags;
  if (a.link) d.link = a.link;
  if (terms && terms.length) d.snippet = snippet(a, terms);
  else d.excerpt = a.excerpt.slice(0, 120);
  return d;
}

/** 蔵書にカテゴリ・タグが実在するか。note由来のバックアップにはどちらも入っていない。 */
function hasTaxonomy() {
  return library.articles.some((a) => a.categories.length > 0 || a.tags.length > 0);
}

function toolSearch(args) {
  ensureLoaded();
  const query = (args.query || '').trim();
  // 上限を高くすると一度の応答で文脈を食い潰すため、意図的に低く抑えている。
  // たくさん見たい場合は日付やタグで絞り込んで複数回に分けるのが正しい使い方。
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));
  const groups = query ? orGroups(query) : [];
  if (query && !groups.length) throw new ShokoError('検索語がありません（OR だけでは検索できません）');
  const flat = groups.flat();

  let list = library.articles;
  const pt = args.post_type;
  if (pt && pt !== 'all') list = list.filter((a) => a.postType === pt);
  if (args.category) {
    const c = args.category.toLowerCase();
    list = list.filter((a) => a.categories.some((x) => x.toLowerCase().includes(c)));
  }
  if (args.tag) {
    const t = args.tag.toLowerCase();
    list = list.filter((a) => a.tags.some((x) => x.toLowerCase().includes(t)));
  }
  list = dateFilter(list, args);
  if (groups.length) {
    list = list.filter((a) => groups.some((g) => g.every((t) => hasTerm(a, t))));
  }

  // 検索語があるときは関連度順が既定。語がなければ順位のつけようがないので日付順。
  const sortMode = args.sort === 'date' || args.sort === 'relevance'
    ? args.sort
    : (groups.length ? 'relevance' : 'date');

  const byDate = (x, y) => {
    const dx = x.date || '', dy = y.date || '';
    if (dx === dy) return x.id - y.id;
    return dx < dy ? 1 : -1;
  };

  let sorted;
  if (sortMode === 'relevance' && groups.length) {
    // idfは蔵書全体で数える。絞り込み後の母集団で数えると、
    // 絞り方によって同じ語の重みが変わってしまう。
    const total = library.articles.length;
    const dfMap = new Map();
    for (const t of new Set(flat)) {
      let n = 0;
      for (const a of library.articles) if (hasTerm(a, t)) n++;
      dfMap.set(t, n);
    }
    const idf = (t) => idfOf(dfMap.get(t) || 0, total);
    const scored = list.map((a) => ({ a, s: relevanceOf(a, groups, idf) }));
    scored.sort((x, y) => (y.s !== x.s ? y.s - x.s : byDate(x.a, y.a)));
    sorted = scored.map((x) => {
      x.a._score = x.s;
      return x.a;
    });
  } else {
    sorted = list.slice().sort(byDate);
  }

  const out = {
    query,
    total_matched: sorted.length,
    returned: Math.min(sorted.length, limit),
    sorted_by: sortMode === 'relevance' ? 'relevance' : 'date',
    results: sorted.slice(0, limit).map((a) => {
      const d = summarize(a, flat);
      if (sortMode === 'relevance' && a._score !== undefined) d.score = Math.round(a._score * 10) / 10;
      return d;
    }),
  };
  if (sortMode === 'relevance' && out.results.length) {
    out.score_meaning =
      '検索語との関連度。珍しい語ほど、またタイトルに含まれる記事ほど高い。' +
      '日付は考慮していないので、この並びは新しさとは無関係。';
  }
  if (sorted.length > limit) {
    const order = sortMode === 'relevance' ? '関連度の高い順に' : '新しい順に';
    const filters = hasTaxonomy() ? 'date_from / date_to / tag / category' : 'date_from / date_to';
    out.note =
      `該当${sorted.length}件のうち${order}${limit}件だけ返しています。` +
      `全件を読み込もうとせず、${filters} で絞り込むか、検索語を具体的にしてください。`;
    if (sortMode === 'relevance') {
      out.note += ' 新しいものが知りたい場合は sort="date" か date_from を使ってください。';
    }
  }
  return out;
}

// ------------------------------------------------- 関連記事・重複チェック
// Stats.swift の Related / extractTokens の移植。
// 日本語は語の切れ目が自明でないため、CJKは2文字ずつのbigram、英数字は3文字以上の語で扱う。

/** CJK 2文字bigram + 英数字3文字以上のトークン抽出 */
function extractTokens(text) {
  const out = new Set();
  let word = '';
  let run = [];
  const flushWord = () => {
    if (word.length >= 3) out.add(word.toLowerCase());
    word = '';
  };
  const flushRun = () => {
    if (run.length >= 2) {
      for (let i = 0; i < run.length - 1; i++) out.add(run[i] + run[i + 1]);
    }
    run = [];
  };
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const isAlnum =
      c < 128 && ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122));
    // U+3000-9FFF（かな・カナ・漢字ほか）+ U+FF00-FFEF（全角英数）
    const isCJK = (c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef);
    if (isAlnum) word += ch;
    else flushWord();
    if (isCJK) run.push(ch);
    else flushRun();
  }
  flushWord();
  flushRun();
  return out;
}

/**
 * ひらがなだけのbigramを捨てる。「する」「こと」「から」といった機能語が
 * どの記事にも出るせいで、内容と無関係な記事が上位に来るのを防ぐ。
 * 内容語はたいてい漢字・カタカナ・英数字を含む。
 */
function isHiraganaOnly(tok) {
  for (const ch of tok) {
    const c = ch.codePointAt(0);
    if (c < 0x3041 || c > 0x309f) return false;
  }
  return true;
}

/**
 * 文字種を返す。h=ひらがな k=カタカナ j=漢字 a=英数字 null=区切り。
 * 日本語には語の区切りに空白がないため、文字種の変わり目を語の境目とみなす。
 * 完全ではないが、辞書なしで「クラムボン」「宮沢賢治」を1語として取り出せる。
 */
function charClass(c) {
  if (c < 128) {
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return 'a';
    return null;
  }
  if (c >= 0x3041 && c <= 0x309f) return 'h';
  if (c === 0x30fc) return 'k'; // 長音符はカタカナ側に付ける
  if (c >= 0x30a0 && c <= 0x30ff) return 'k';
  if (c === 0x3005 || c === 0x3007) return 'j'; // 々 〇
  if (c >= 0x3400 && c <= 0x4dbf) return 'j';
  if (c >= 0x4e00 && c <= 0x9fff) return 'j';
  return null; // 句読点・記号・絵文字はすべて区切り
}

/**
 * 照合のもとにする文章から語を取り出す。
 *
 * bigramで刻むと「アップデート」のような長い語が4つの断片になり、
 * 短くて珍しい「書庫」1つより重くなる。そこで語の長さで割るのだが、
 * 何を「1語」と数えるかを間違えると破綻する。日本語の文は句読点まで含めて
 * 文字コードが連続しているので、素朴に区切ると一文まるごとが1語になり、
 * 100字のメモが1/99ずつに薄まって何も効かなくなる（v1.1.0のバグ）。
 * 文字種の変わり目で切ることで、語らしい単位で割れるようにしている。
 *
 * 返り値は { t: 語, scale: 重みの倍率 } の配列。
 */
function baseTokens(text) {
  const segs = [];
  let cur = '';
  let curCls = null;
  const flush = () => {
    if (cur && curCls) segs.push({ s: cur, cls: curCls });
    cur = '';
  };
  for (const ch of text) {
    const cls = charClass(ch.codePointAt(0));
    if (cls !== curCls) {
      flush();
      curCls = cls;
    }
    if (cls) cur += ch;
  }
  flush();

  const best = new Map();
  for (const { s, cls } of segs) {
    if (cls === 'h') continue; // ひらがなだけの区間は「する」「こと」等の機能語
    let toks;
    if (cls === 'a') {
      if (s.length < 3) continue;
      toks = [s];
    } else if (s.length === 1) {
      // 一文字の漢字は「取」「込」のように文中のどこにでも現れる。
      // 本文4400字に対する部分一致では当たって当然なので、照合には使わない。
      continue;
    } else {
      toks = [];
      for (let i = 0; i < s.length - 1; i++) toks.push(s[i] + s[i + 1]);
    }
    const scale = 1 / toks.length;
    for (const t of toks) {
      if (isHiraganaOnly(t)) continue;
      if (!best.has(t) || best.get(t) < scale) best.set(t, scale);
    }
  }
  return [...best.entries()].map(([t, scale]) => ({ t, scale }));
}

/** タイトルのトークン集合。使う直前に作って記事に持たせる（全記事ぶん先に作ると重い） */
function titleTokensOf(a) {
  if (!a.titleTokens) a.titleTokens = extractTokens(a.titleLower);
  return a.titleTokens;
}

/**
 * 語がいくつのタイトルに出るかの表。蔵書を読み直したときだけ作り直す。
 * これがないと「アップデート」「リリース」のような、この書き手が何度も使う語だけで
 * 順位が決まってしまい、題材が違う記事が上位に並ぶ。
 */
const tokenDF = { fingerprint: null, map: null };

function titleDF() {
  if (tokenDF.fingerprint === library.fingerprint && tokenDF.map) return tokenDF.map;
  const m = new Map();
  for (const a of library.articles) {
    for (const t of titleTokensOf(a)) m.set(t, (m.get(t) || 0) + 1);
  }
  tokenDF.fingerprint = library.fingerprint;
  tokenDF.map = m;
  return m;
}

/**
 * 語の重み。珍しい語ほど重い。
 * idfをそのまま使うと対数のせいで差が潰れ、ありふれた語でも数を揃えれば勝ててしまう。
 * 2乗して、珍しい語ひとつが常用語数個より効くようにする。
 */
function weightOf(df, total) {
  const idf = idfOf(df, total);
  return idf * idf;
}

/** 照合に使う語の上限。本文からは語が数百出るので、珍しい順に絞って総当たりの回数を抑える */
const MAX_BODY_TERMS = 60;

/**
 * 足切り。点数は「渡した文章の特徴語のうち何割を共有しているか」なので、
 * 渡す文章が長いほど語が増え、どの記事も全部は覆えなくなって全体に下がる。
 * そのため企画メモを渡す場合と既存記事まるごとを渡す場合で水準が変わる。
 *
 * 蔵書1008本で測ると、企画メモでは正解が32〜82、無関係な話題の最高が5〜26。
 * 一見分かれているようで、メモの書き方を変えると正解が29台まで落ち、
 * 無関係が26まで上がる。つまり両者の帯は重なっていて、
 * 「何点以上なら同じ題材」と言い切れる境目は存在しない。
 *
 * したがって点数で合否を出すことはせず、足切りは明らかな雑音を落とす位置に置き、
 * 判断材料としては順位と、突出しているかどうか（confidence）を返す。
 */
const SIMILAR_LEVELS = {
  text: { floor: 15, likely: 30, maybe: 22 },
  article: { floor: 7, likely: 15, maybe: 10 },
};

/** 点が中位でも、2位をこの倍率で引き離していれば「らしい」と見なす */
const STANDOUT_RATIO = 1.7;

/**
 * この語数を下回ったら、点数からは何も言えないものとして扱う。
 * 点は「特徴語のうち何割を共有しているか」なので、1語しか渡さなければ
 * その語を含む記事はすべて100点になる。判定の材料にならない。
 */
const MIN_TERMS = 5;

/**
 * ある文章に近い記事を探す。
 *
 * 相手のタイトルに出る語は重く、本文にしか出ない語は軽く見る。
 * 本文まで見るのは、題材に触れていてもタイトルには出さない記事があるため。
 * これを省くと「書いたのに見つからない」が起きる。
 */
function similarTo(titleText, bodyText, excludeId, limit, floorAbs) {
  const df = titleDF();
  const total = library.articles.length;
  const cut = Math.max(3, Math.floor(total * 0.05));

  // 語 → 重みの倍率。想定タイトル由来の語は、本文由来より重く扱う。
  const terms = new Map();
  const add = (list, srcWeight) => {
    for (const { t, scale } of list) {
      const v = scale * srcWeight;
      if (!terms.has(t) || terms.get(t) < v) terms.set(t, v);
    }
  };
  add(baseTokens(normalizeText(titleText || '').toLowerCase()), 3);

  // 蔵書の5%を超えるタイトルに現れる常用語を捨て、残りを珍しい順に上位だけ使う。
  const body = baseTokens(normalizeText((bodyText || '').slice(0, 3000)).toLowerCase())
    .filter((x) => (df.get(x.t) || 0) <= cut)
    .sort((p, q) => (df.get(p.t) || 0) - (df.get(q.t) || 0))
    .slice(0, MAX_BODY_TERMS);
  add(body, 1);
  if (!terms.size) return { hits: [], termCount: 0 };

  const w = (t) => weightOf(df.get(t) || 0, total);
  const weighted = [...terms.entries()].map(([t, v]) => ({ t, v: v * w(t) }));

  // 満点＝渡された文章の特徴語が、すべて相手のタイトルに出ている状態。
  // これで割ることで、点数が入力の長さに左右されなくなり、
  // 「その文章を特徴づける語のうち何割を共有しているか」として読めるようになる。
  const full = weighted.reduce((n, x) => n + 3 * x.v, 0) || 1;

  const scored = [];
  for (const x of library.articles) {
    if (x.id === excludeId) continue;
    if (x.postType !== 'post') continue;
    let s = 0;
    for (const { t, v } of weighted) {
      if (x.titleLower.includes(t)) s += 3 * v;
      else if (x.plainLower.includes(t)) s += v;
    }
    if (s > 0) scored.push({ a: x, s: (100 * s) / full });
  }
  scored.sort((p, q) => {
    if (q.s !== p.s) return q.s - p.s;
    const dp = p.a.date || '', dq = q.a.date || '';
    if (dp !== dq) return dp < dq ? 1 : -1; // 同点なら新しい方
    return p.a.id - q.a.id;
  });

  // 上位から大きく離れたものは「たまたま語が重なっただけ」。足切りする。
  if (!scored.length) return { hits: [], termCount: terms.size, ratio: 0 };
  const floor = Math.max(scored[0].s * 0.5, floorAbs);
  // 2位との比は足切り前の並びで取る。足切りで1件しか残らなかった場合でも、
  // それが本当に抜けていたのか、単に全体が低かっただけなのかを区別するため。
  const ratio = scored[1] && scored[1].s > 0 ? scored[0].s / scored[1].s : Infinity;
  return { hits: scored.filter((x) => x.s >= floor).slice(0, limit), termCount: terms.size, ratio };
}

function toolFindSimilar(args) {
  ensureLoaded();
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 30));

  let base = null;
  let titleText = args.title_text || '';
  let bodyText = args.text || '';

  if (args.id !== undefined && args.id !== null) {
    base = library.articles.find((x) => x.id === Number(args.id)) || null;
    if (!base) throw new ShokoError('該当する記事がありません');
  } else if (args.link) {
    base = library.articles.find((x) => x.link === args.link) || null;
    if (!base) throw new ShokoError('該当する記事がありません');
  } else if (!bodyText && !titleText) {
    throw new ShokoError('id / link、または text（下書きや企画メモの本文）を指定してください');
  }

  if (base) {
    titleText = base.title;
    bodyText = base.plain;
  }

  const level = base ? SIMILAR_LEVELS.article : SIMILAR_LEVELS.text;
  const { hits, termCount, ratio } = similarTo(titleText, bodyText, base ? base.id : -1, limit, level.floor);
  const out = {
    basis: base ? { id: base.id, title: base.title, date: base.date } : { text_length: (titleText + bodyText).length },
    total_candidates: hits.length,
    terms_used: termCount,
    score_meaning:
      '渡した文章の特徴語のうち、その記事がどれだけ共有しているかの割合(0〜100)。' +
      'この数字が意味を持つのは同じ結果の中での比較だけで、呼び出しをまたぐと水準が変わる。' +
      '「何点以上なら同じ題材」という境目は存在しないので、点数で足切りせず、上位から本文を見て判断すること。',
    results: hits.map((h) => {
      const d = summarize(h.a, null);
      d.score = Math.round(h.s * 10) / 10;
      return d;
    }),
  };

  if (!hits.length) {
    out.confidence = 'none';
    out.note =
      '語の重なりでは近い記事が見つかりませんでした。ただしこの判定は語の一致に基づくもので、' +
      '同じ題材を別の言い回しで書いていれば見落とします。重要な確認なら、題材の固有名詞を' +
      'search_articles で直接引いて裏を取ってください。';
  } else if (termCount < MIN_TERMS) {
    // 語が少なすぎるときは点数から何も言えない。ここで likely を出すと、
    // 「点数は当てにならない」と言いながらその点数を根拠にすることになる。
    out.confidence = 'unclear';
    out.note =
      `照合に使えた特徴語が${termCount}語しかないため、点数からは何も判断できません` +
      '（1語だけなら、その語を含む記事はすべて満点になります）。' +
      '一覧は語が重なる記事というだけの意味です。題材を説明する文章を数行渡すか、' +
      'search_articles で直接引いてください。' +
      'なお、蔵書のタイトルに何度も出てくる語は、記事を絞り込めないため照合から外しています。' +
      'そのせいで語数が減っている場合もあります。';
  } else {
    const top = hits[0].s;
    const likely = top >= level.likely || (top >= level.maybe && ratio >= STANDOUT_RATIO);
    out.confidence = likely ? 'likely' : 'unclear';
    out.note = likely
      ? '同じ題材を扱った記事がある可能性が高いと見ています（1位の点が高いか、2位を大きく引き離しています）。' +
        'ただし判断はこの一覧ではなく、上位の本文を読んで決めてください。'
      : '語がいくらか重なる記事はありますが、この並びだけでは同じ題材かどうか判断できません。' +
        '無関係な文章を渡してもこの程度の候補は返ります。上位数件の本文を確認してください。';
    if (!base) {
      out.note += ' 逆に、ここに出ていなくても別の言い回しで書いている可能性は残ります。';
    }
  }
  return out;
}

/**
 * ある話題について、いつ何を書いてきたかを時系列で返す。
 * 1件あたりを日付とタイトルだけに切り詰めるので、検索より多く並べられる。
 */
function toolTopicTimeline(args) {
  ensureLoaded();
  const query = (args.query || '').trim();
  if (!query) throw new ShokoError('query を指定してください');
  const limit = Math.max(1, Math.min(Number(args.limit) || 40, 100));
  const groups = orGroups(query);
  if (!groups.length) throw new ShokoError('検索語がありません（OR だけでは検索できません）');

  let list = library.articles.filter((a) => a.postType === 'post');
  list = dateFilter(list, args);
  list = list.filter((a) => groups.some((g) => g.every((t) => hasTerm(a, t))));

  list.sort((x, y) => {
    const dx = x.date || '', dy = y.date || '';
    if (dx === dy) return x.id - y.id;
    return dx < dy ? -1 : 1; // 古い順。話の変化を追うため
  });

  const byMonth = {};
  for (const a of list) {
    if (!a.date) continue;
    const mk = a.date.slice(0, 7);
    byMonth[mk] = (byMonth[mk] || 0) + 1;
  }

  const dated = list.filter((a) => a.date); // 日付なしは並びの先頭に来るので、期間には使わない
  const out = {
    query,
    total_matched: list.length,
    first: dated.length ? dated[0].date : null,
    last: dated.length ? dated[dated.length - 1].date : null,
    by_month: byMonth,
    returned: Math.min(list.length, limit),
    articles: [],
  };

  // 多すぎる場合は、両端を残しつつ間引く。変化を見たいので最初と最後は落とさない。
  let picked = list;
  if (list.length > limit) {
    const step = list.length / limit;
    picked = [];
    for (let i = 0; i < limit; i++) picked.push(list[Math.floor(i * step)]);
    picked[picked.length - 1] = list[list.length - 1];
    out.note =
      `該当${list.length}件を、期間全体が見渡せるよう${limit}件に間引いています。` +
      '間引いた一覧はタイトルしか返さないため、話題が広すぎると並べても流れが読めません。' +
      '検索語を具体的にするか、date_from / date_to で時期を区切って呼び直すほうが有用です。';
  }

  // 少数なら抜粋も付ける。タイトルだけでは、その記事が話題に
  // どう関わっているのか分からないことが多いため。
  const withSnippet = picked.length <= 15;
  out.articles = picked.map((a) => {
    const d = { id: a.id, date: a.date, title: a.title || '(無題)' };
    if (withSnippet) d.snippet = snippet(a, groups.flat(), 80);
    return d;
  });
  if (!withSnippet && !out.note) {
    out.note = '一覧は日付とタイトルのみです。中身が要る記事は get_article で個別に取ってください。';
  }
  return out;
}

function toolGetArticle(args) {
  ensureLoaded();
  let a = null;
  if (args.id !== undefined && args.id !== null) {
    a = library.articles.find((x) => x.id === Number(args.id)) || null;
  } else if (args.link) {
    a = library.articles.find((x) => x.link === args.link) || null;
  } else if (args.title) {
    const t = args.title.toLowerCase();
    const hits = library.articles
      .filter((x) => x.title.toLowerCase().includes(t))
      .sort((x, y) => {
        const dx = x.date || '', dy = y.date || '';
        if (dx !== dy) return dx < dy ? 1 : -1;
        return x.id - y.id;
      });
    a = hits[0] || null;
  } else {
    throw new ShokoError('id / link / title のいずれかを指定してください');
  }
  if (!a) throw new ShokoError('該当する記事がありません');

  const out = summarize(a, null);
  const fmt = args.format || 'markdown';
  if (fmt === 'html') out.content = a.contentHTML;
  else if (fmt === 'text') out.content = a.plain;
  else out.content = htmlToMarkdown(a.contentHTML, a.title, a.date);
  return out;
}

function statusCounts(arts) {
  const m = {};
  for (const a of arts) m[a.status] = (m[a.status] || 0) + 1;
  return m;
}

function toolLibraryInfo() {
  ensureLoaded();
  const arts = library.articles;
  const dates = arts.map((a) => a.date).filter(Boolean).sort();
  const types = {};
  const cats = new Map();
  const tags = new Map();
  for (const a of arts) {
    types[a.postType] = (types[a.postType] || 0) + 1;
    for (const c of a.categories) cats.set(c, (cats.get(c) || 0) + 1);
    for (const t of a.tags) tags.set(t, (tags.get(t) || 0) + 1);
  }
  const top = (m) =>
    [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 20).map(([name, count]) => ({ name, count }));

  const out = {
    channel_title: library.channelTitle,
    article_count: arts.length,
    date_range: { from: dates[0] || null, to: dates[dates.length - 1] || null },
    post_types: types,
    total_characters: arts.reduce((n, a) => n + a.wordCount, 0),
    top_categories: top(cats),
    top_tags: top(tags),
    statuses: statusCounts(arts),
    data_location: 'local',
    configuration_source: WXR.source,
    loaded_at: library.loadedAt,
  };
  // 空の分類を黙って返すと、使えない絞り込みを試させることになる。
  if (cats.size === 0 && tags.size === 0) {
    out.note =
      'この蔵書にはカテゴリ・タグが含まれていません（noteのバックアップには元から入っていません）。' +
      'search_articles の category / tag は使えないので、検索語と date_from / date_to で絞り込んでください。';
  }
  return out;
}

// ---------------------------------------------------------------- MCP

const TOOLS = [
  {
    name: 'library_info',
    description:
      '書庫（noteなどのブログバックアップ）全体の概要を返す。記事数、期間、よく使うカテゴリ・タグがわかる。' +
      '何が入っているか把握したいときに最初に呼ぶ。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_articles',
    description:
      '書庫から記事を検索する。queryはスペース区切りでAND、単語 OR でOR検索。' +
      'タイトル・本文・カテゴリ・タグを部分一致で見る。返るのは一覧（タイトル・日付・該当箇所の抜粋）で、' +
      '本文は含まない。本文が必要な記事だけを get_article で個別に取ること。\n' +
      '既定は関連度順（珍しい語ほど、またタイトルに含まれる記事ほど上位）。' +
      '順位は日付を一切見ないので、3年前の記事が1位に来ることが普通にある。' +
      '「最近」「直近」「ここ数か月」のように新しさが問われている質問では、' +
      'sort="date" にするか date_from で期間を切ること。既定のまま呼ぶと古い記事が並んで質問に答えられない。\n' +
      '蔵書は1000本規模あるため、該当が多いときは全件を取ろうとせず、検索語を具体的にするか期間で絞る。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "検索語。例: 'Claude 移植'、'Swift OR SwiftUI'。空なら絞り込みのみ" },
        sort: {
          type: 'string',
          enum: ['relevance', 'date'],
          description:
            'relevance=関連度順（検索語があるときの既定）。date=新しい順。' +
            '「最近書いたもの」を聞かれたら date にする',
        },
        date_from: { type: 'string', description: 'この日以降 YYYY-MM-DD。「最近」の質問ではこれで期間を切るのが確実' },
        date_to: { type: 'string', description: 'この日以前 YYYY-MM-DD' },
        limit: { type: 'integer', description: '最大件数（既定20、上限50）。多く取るほど文脈を消費するので、まず既定のまま試すこと' },
        post_type: { type: 'string', enum: ['post', 'page', 'all'], description: '投稿タイプ（既定: all）。noteの蔵書はすべて post なので通常は指定不要' },
        category: { type: 'string', description: 'カテゴリで絞り込む（部分一致）。蔵書に分類がある場合のみ有効。noteのバックアップには分類が無い' },
        tag: { type: 'string', description: 'タグで絞り込む（部分一致）。蔵書に分類がある場合のみ有効。noteのバックアップには分類が無い' },
      },
    },
  },
  {
    name: 'find_similar',
    description:
      'ある文章に近い過去記事を探す。用途は2つ。\n' +
      '(1) これから書く記事の題材を text に、想定タイトルを title_text に渡して、' +
      '同じネタを過去に書いていないか確認する。検索語を思いつく必要がないので、' +
      '「この話、前に書いたっけ」の確認にはこちらを使う。title_text は指定すると精度が上がる。\n' +
      '(2) id / link で既存記事を渡して、関連記事や本文から張る自己引用リンクの候補を出す。' +
      'こちらの方が精度は高い。記事のidが分からないときは search_articles で先に引く。\n' +
      '判定は語の一致に基づくので、同じ題材を別の言い回しで書いていれば見落とす。' +
      '点数に「何点以上なら同じ題材」という境目はない。信用してよいのは順位と、' +
      '1位が他から離れているかどうか（confidence）だけで、最後は本文を見て判断すること。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '下書きや企画メモの本文。数百字あれば十分。固有名詞が入っているほど当たる' },
        title_text: { type: 'string', description: '想定タイトル。textと併用する。ここに書かれた語は本文由来の語より重く見るため、指定すると精度が上がる' },
        id: { type: 'integer', description: '基準にする既存記事のid（search_articlesの結果から取る）' },
        link: { type: 'string', description: '基準にする既存記事のURL' },
        limit: { type: 'integer', description: '最大件数（既定10、上限30）' },
      },
    },
  },
  {
    name: 'topic_timeline',
    description:
      'ある話題について書いた記事を古い順に並べ、月ごとの本数も返す。' +
      'ある時期に集中しているのか、ずっと書き続けているのかを掴むのに使う。\n' +
      '返るのは日付とタイトル（該当が15件以下なら短い抜粋も付く）で、記事の主張そのものは含まない。' +
      '「主張がどう変わったか」まで答えるには、ここで当たりをつけてから get_article で数本読む必要がある。' +
      'これは一覧であって答えではない。\n' +
      '該当が数百件になると、タイトルだけを並べても話の流れは読めない。' +
      'その場合は query を具体的にするか、date_from / date_to で時期を区切って呼び直すこと。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "話題を表す検索語。具体的なほど有用。例: 'Claude 料金' は良いが 'Claude' だけでは広すぎる" },
        date_from: { type: 'string', description: 'この日以降 YYYY-MM-DD' },
        date_to: { type: 'string', description: 'この日以前 YYYY-MM-DD' },
        limit: { type: 'integer', description: '最大件数（既定40、上限100）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_article',
    description: '記事1件の本文を取得する。id（search_articlesの結果）かlink、またはtitleの部分一致で指定。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'search_articles が返した id' },
        link: { type: 'string', description: '記事のURL' },
        title: { type: 'string', description: 'タイトルの部分一致（最新の1件）' },
        format: { type: 'string', description: 'markdown（既定） / html / text' },
      },
    },
  },
];

const TOOL_TITLES = {
  library_info: '書庫の概要',
  search_articles: '記事を検索',
  find_similar: '似た記事を探す',
  topic_timeline: '話題を時系列で並べる',
  get_article: '記事本文を取得',
};

// どれも手元のファイルを読むだけ。クライアントが確認なしで呼べるよう明示する
for (const tool of TOOLS) {
  tool.title = TOOL_TITLES[tool.name];
  tool.annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
}

const INSTRUCTIONS =
  '書庫はローカルのWXRブログバックアップを読み取り専用で検索します。' +
  'まず search_articles などで候補を絞り、本文が必要な記事だけ get_article で取得してください。';

const HANDLERS = {
  library_info: toolLibraryInfo,
  search_articles: toolSearch,
  find_similar: toolFindSimilar,
  topic_timeline: toolTopicTimeline,
  get_article: toolGetArticle,
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
    return;
  }
  const { method, id } = msg;
  // "params": null を送ってくるクライアントもある。既定値の構文では null を拾えない
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  if (method === 'initialize') {
    const asked = params.protocolVersion;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      },
    });
    return;
  }

  if (id === undefined || id === null) return; // 通知には応答しない

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const fn = HANDLERS[params.name];
    if (!fn) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params.name}` } });
      return;
    }
    try {
      const payload = fn(params.arguments || {});
      // 整形せずに返す。インデントは読み手（Claude）に何の利益もなく、文脈だけ食う。
      send({
        jsonrpc: '2.0',
        id,
        // structuredContent は付けない。クライアントによっては text と二重にモデルへ渡り、文脈を倍食うため
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      });
    } catch (e) {
      // ツール内のエラーはisErrorで返す。プロトコル自体は壊さない。
      log(`tool error ${params.name}: ${e.stack || e.message}`);
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `エラー: ${e.message}` }], isError: true },
      });
    }
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
}

function main() {
  if (process.argv[2] === '--selftest') {
    try {
      ensureLoaded();
      console.log(JSON.stringify(toolLibraryInfo(), null, 2));
    } catch (e) {
      console.error(`エラー: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  log(`読み込み先: ${WXR.source}${WXR_DIR ? ` (${path.basename(WXR_DIR)})` : ''}`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    try {
      handle(msg);
    } catch (e) {
      log(`fatal in handle: ${e.stack || e.message}`);
    }
  });
  rl.on('close', () => process.exit(0));
}

main();
