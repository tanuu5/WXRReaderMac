#!/usr/bin/env node
/**
 * 書庫 MCP — WXRブログバックアップをClaudeから検索・閲覧できるようにするMCPサーバ。
 *
 * - 依存パッケージなし（Node標準ライブラリのみ）
 * - WXR解析とHTML→Markdown変換は macOSアプリ「書庫」(WXRReaderMac) のSwift実装からの移植
 * - ネットワーク送信は一切しない
 *
 * 読み込み先は環境変数 SHOKO_WXR_DIR。.mcpb 経由の場合はインストール時に
 * Claude Desktop がフォルダ選択UIを出して設定する。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SERVER_NAME = 'shoko';
const SERVER_VERSION = '1.0.0';

const WXR_DIR = process.env.SHOKO_WXR_DIR || '';

function log(msg) {
  // stdoutはJSON-RPC専用。ログは必ずstderrへ。
  process.stderr.write(`[shoko] ${msg}\n`);
}

// ---------------------------------------------------------------- WXR解析
// WXRParser.swift の移植。整形式XMLに依存せず、CDATAを考慮した文字列走査で <item> を抽出する。

const TAXONOMY_RE =
  /<category\s+domain="(category|post_tag)"[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/g;
const TAG_STRIP_RE = /<[^>]*>/g;

const ENTITIES = [
  ['&nbsp;', ' '], ['&amp;', '&'], ['&lt;', '<'],
  ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&#x27;', "'"],
];

function decodeEntities(s) {
  for (const [from, to] of ENTITIES) s = s.split(from).join(to);
  return s;
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

function stripHTML(html) {
  if (!html) return '';
  return decodeEntities(html.replace(TAG_STRIP_RE, ''));
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

/** CDATA内の "</item>" を誤検出しないよう、CDATA開閉数を照合して真の終端を探す */
function findItemEnd(text, itemBodyStart) {
  let searchFrom = itemBodyStart;
  for (;;) {
    const r = text.indexOf('</item>', searchFrom);
    if (r < 0) return -1;
    const seg = text.slice(itemBodyStart, r);
    if (countOccurrences(seg, '<![CDATA[') <= countOccurrences(seg, ']]>')) return r;
    searchFrom = r + 7;
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

function parseItem(item, sourceFile) {
  const title = unwrapCDATA(tagContent('title', item) || '');
  const link = unwrapCDATA(tagContent('link', item) || '');
  const pubDate = tagContent('pubDate', item) || '';
  const postDate = unwrapCDATA(tagContent('wp:post_date', item) || '');
  const postType = unwrapCDATA(tagContent('wp:post_type', item) || '') || 'post';
  const status = unwrapCDATA(tagContent('wp:status', item) || '') || 'publish';

  const contentHTML = contentEncoded(item);
  const plain = stripHTML(contentHTML);

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
    wordCount: plain.length,
    categories,
    tags,
    sourceFile,
    searchBlob: (title + '\n' + plain + '\n' + categories.join(' ') + '\n' + tags.join(' ')).toLowerCase(),
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
    b = rsub(b, `<h${level}[^>]*>(.*?)</h${level}>`, (_, x) => `\n${h} ${x.trim()}\n\n`);
  }
  b = rsub(b, '<strong[^>]*>(.*?)</strong>', (_, x) => `**${x}**`);
  b = rsub(b, '<b[^>]*>(.*?)</b>', (_, x) => `**${x}**`);
  b = rsub(b, '<em[^>]*>(.*?)</em>', (_, x) => `*${x}*`);
  b = rsub(b, '<i[^>]*>(.*?)</i>', (_, x) => `*${x}*`);
  b = rsub(b, '<del[^>]*>(.*?)</del>', (_, x) => `~~${x}~~`);
  b = rsub(b, '<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', (_, href, x) => `[${x}](${href})`);
  b = rsub(b, '<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*/?>', (_, src, alt) => `![${alt}](${src})`);
  b = rsub(b, '<img[^>]*src="([^"]*)"[^>]*/?>', (_, src) => `![](${src})`);
  b = rsub(b, '<figure[^>]*>(.*?)</figure>', (_, x) => `\n${x}\n`);
  b = rsub(b, '<figcaption[^>]*>(.*?)</figcaption>', (_, x) => `*${x}*\n`);
  b = rsub(b, '<li[^>]*>(.*?)</li>', (_, x) => `- ${x}\n`);
  b = rsub(b, '</?[uo]l[^>]*>', () => '\n');
  b = rsub(b, '<blockquote[^>]*>(.*?)</blockquote>',
    (_, x) => x.trim().split('\n').map((ln) => '> ' + ln.trim()).join('\n') + '\n\n');
  b = rsub(b, '<pre[^>]*><code[^>]*>(.*?)</code></pre>', (_, x) => `\n\`\`\`\n${x}\n\`\`\`\n\n`);
  b = rsub(b, '<code[^>]*>(.*?)</code>', (_, x) => `\`${x}\``);
  b = rsub(b, '<br\\s*/?>', () => '\n');
  b = rsub(b, '<p[^>]*>(.*?)</p>', (_, x) => `${x}\n\n`);
  b = rsub(b, '<hr[^>]*/?>', () => '\n---\n\n');
  b = rsub(b, '<div[^>]*>(.*?)</div>', (_, x) => `${x}\n`);
  b = rsub(b, '<iframe[^>]*src="([^"]*)"[^>]*>.*?</iframe>', (_, src) => `\n[埋め込み](${src})\n`);
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

/** 必要なら読み直す。呼ぶたびに鮮度を確認するので、呼び出し側は何も考えなくてよい。 */
function ensureLoaded() {
  if (!WXR_DIR) {
    throw new ShokoError(
      'バックアップフォルダが設定されていません。Claude Desktop の 設定 → 拡張機能 → 書庫 で、' +
      'noteのWXR(.xml)が入っているフォルダを指定してください。'
    );
  }
  if (!fs.existsSync(WXR_DIR)) {
    throw new ShokoError(`設定されたフォルダが見つかりません: ${WXR_DIR}`);
  }

  const files = collectXMLs(WXR_DIR);
  if (files.length === 0) {
    throw new ShokoError(
      `${WXR_DIR} に .xml が見つかりません。noteのバックアップzipを展開したフォルダを指定してください。`
    );
  }

  const fp = fingerprintOf(files);
  if (fp === library.fingerprint) return;

  const started = Date.now();
  const articles = [];
  let channelTitle = '';
  const seen = new Set();
  for (const f of files) {
    const base = path.basename(f);
    if (seen.has(base)) continue; // アプリ側と同じくファイル名で重複除去
    seen.add(base);
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (e) {
      log(`読めませんでした: ${f} (${e.message})`);
      continue;
    }
    const r = parseWXR(text, base);
    if (!channelTitle && r.channelTitle) channelTitle = r.channelTitle;
    for (const a of r.articles) {
      a.id = articles.length;
      articles.push(a);
    }
  }

  library.fingerprint = fp;
  library.channelTitle = channelTitle;
  library.articles = articles;
  library.loadedAt = new Date().toISOString();
  log(`${files.length}ファイルから${articles.length}件を読み込みました (${Date.now() - started}ms)`);
}

// ---------------------------------------------------------------- 検索
// AppState.swift と同じ意味論: スペース区切り=AND、単語 OR=OR、部分一致（小文字化）

function orGroups(q) {
  return q
    .split(/\bOR\b/i)
    .map((part) => part.toLowerCase().split(/\s+/).filter(Boolean))
    .filter((g) => g.length > 0);
}

function snippet(plain, terms, width = 120) {
  const low = plain.toLowerCase();
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0) {
      const s = Math.max(0, i - width / 2);
      const e = Math.min(plain.length, i + t.length + width / 2);
      return (s > 0 ? '…' : '') + plain.slice(s, e).replace(/\s+/g, ' ') + (e < plain.length ? '…' : '');
    }
  }
  return plain.slice(0, width).replace(/\s+/g, ' ');
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
  if (a.categories.length) d.categories = a.categories;
  if (a.tags.length) d.tags = a.tags;
  if (a.link) d.link = a.link;
  if (terms && terms.length) d.snippet = snippet(a.plain, terms);
  else d.excerpt = a.excerpt.slice(0, 120);
  return d;
}

function toolSearch(args) {
  ensureLoaded();
  const query = (args.query || '').trim();
  // 上限を高くすると一度の応答で文脈を食い潰すため、意図的に低く抑えている。
  // たくさん見たい場合は日付やタグで絞り込んで複数回に分けるのが正しい使い方。
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));
  const groups = query ? orGroups(query) : [];
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
  if (args.date_from) list = list.filter((a) => a.date && a.date >= args.date_from);
  if (args.date_to) list = list.filter((a) => a.date && a.date <= args.date_to);
  if (groups.length) {
    list = list.filter((a) => groups.some((g) => g.every((t) => a.searchBlob.includes(t))));
  }

  const sorted = list.slice().sort((x, y) => {
    const dx = x.date || '', dy = y.date || '';
    if (dx === dy) return x.id - y.id;
    return dx < dy ? 1 : -1;
  });

  const out = {
    query,
    total_matched: sorted.length,
    returned: Math.min(sorted.length, limit),
    results: sorted.slice(0, limit).map((a) => summarize(a, flat)),
  };
  if (sorted.length > limit) {
    out.note =
      `該当${sorted.length}件のうち新しい順に${limit}件だけ返しています。` +
      '全件を読み込もうとせず、date_from / date_to / tag / category で絞り込むか、検索語を具体的にしてください。';
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
      .sort((x, y) => ((y.date || '') < (x.date || '') ? -1 : 1));
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

  return {
    channel_title: library.channelTitle,
    article_count: arts.length,
    date_range: { from: dates[0] || null, to: dates[dates.length - 1] || null },
    post_types: types,
    total_characters: arts.reduce((n, a) => n + a.wordCount, 0),
    top_categories: top(cats),
    top_tags: top(tags),
    wxr_dir: WXR_DIR,
    loaded_at: library.loadedAt,
  };
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
      'タイトル・本文・カテゴリ・タグを部分一致で見る。返るのは一覧（タイトル・日付・抜粋）で、本文は含まない。' +
      '本文が必要な記事だけを get_article で個別に取ること。' +
      '蔵書は1000本規模あるため、該当が多いときは全件を取ろうとせず、' +
      'date_from / date_to / tag / category で絞るか検索語を具体的にする。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "検索語。例: 'Claude 移植'、'Swift OR SwiftUI'。空なら絞り込みのみ" },
        category: { type: 'string', description: 'カテゴリで絞り込む（部分一致）' },
        tag: { type: 'string', description: 'タグで絞り込む（部分一致）' },
        post_type: { type: 'string', description: 'post / page / all（既定: all）' },
        date_from: { type: 'string', description: 'この日以降 YYYY-MM-DD' },
        date_to: { type: 'string', description: 'この日以前 YYYY-MM-DD' },
        limit: { type: 'integer', description: '最大件数（既定20、上限50）。多く取るほど文脈を消費するので、まず既定のまま試すこと' },
      },
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

const HANDLERS = {
  library_info: toolLibraryInfo,
  search_articles: toolSearch,
  get_article: toolGetArticle,
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  const { method, id, params = {} } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
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
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${params.name}` } });
      return;
    }
    try {
      const payload = fn(params.arguments || {});
      // 整形せずに返す。インデントは読み手（Claude）に何の利益もなく、文脈だけ食う。
      send({
        jsonrpc: '2.0',
        id,
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

  log(`WXR_DIR=${WXR_DIR || '(未設定)'}`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
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
