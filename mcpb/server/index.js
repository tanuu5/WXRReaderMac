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
const SERVER_VERSION = '1.1.0';

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
    wordCount: plain.length,
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
  if (sorted.length > limit) {
    const order = sortMode === 'relevance' ? '関連度の高い順に' : '新しい順に';
    const filters = hasTaxonomy() ? 'date_from / date_to / tag / category' : 'date_from / date_to';
    out.note =
      `該当${sorted.length}件のうち${order}${limit}件だけ返しています。` +
      `全件を読み込もうとせず、${filters} で絞り込むか、検索語を具体的にしてください。`;
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
 * 照合のもとにする文章から語を取り出す。
 * 日本語をbigramで刻むと「アップデート」のような長い語が4つの断片になり、
 * 短くて珍しい「書庫」1つより重くなってしまう。語の長さで割って、
 * 1つの語が持ち込める重みを語の長さによらず一定にする。
 * 返り値は { t: 語, scale: 重みの倍率 } の配列。
 */
function baseTokens(text) {
  const runs = [];
  let word = '';
  let run = [];
  const flushWord = () => {
    if (word.length >= 3) runs.push([word.toLowerCase()]);
    word = '';
  };
  const flushRun = () => {
    if (run.length >= 2) {
      const g = [];
      for (let i = 0; i < run.length - 1; i++) g.push(run[i] + run[i + 1]);
      runs.push(g);
    }
    run = [];
  };
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const isAlnum =
      c < 128 && ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122));
    const isCJK = (c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef);
    if (isAlnum) word += ch;
    else flushWord();
    if (isCJK) run.push(ch);
    else flushRun();
  }
  flushWord();
  flushRun();

  const best = new Map();
  for (const g of runs) {
    const scale = 1 / g.length;
    for (const t of g) {
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

/**
 * ある文章に近い記事を探す。
 * タイトル由来の語を重く見て、本文由来の語は「相手のタイトルに出るか」だけを見る。
 * 本文どうしの総当たりは1000本規模だと重すぎるうえ、精度もさして上がらない。
 */
function similarTo(titleText, bodyText, excludeId, limit) {
  const df = titleDF();
  const total = library.articles.length;
  const titleToks = baseTokens(normalizeText(titleText || '').toLowerCase());
  let bodyToks = baseTokens(normalizeText((bodyText || '').slice(0, 3000)).toLowerCase());

  // 本文からは語が数千出るので、蔵書の5%を超えるタイトルに現れる常用語は捨てる。
  // 残るのは、その文章を他と区別している語だけになる。
  const cut = Math.max(3, Math.floor(total * 0.05));
  bodyToks = bodyToks.filter((x) => (df.get(x.t) || 0) <= cut);
  if (!titleToks.length && !bodyToks.length) return [];

  const w = (t) => weightOf(df.get(t) || 0, total);
  const scored = [];
  for (const x of library.articles) {
    if (x.id === excludeId) continue;
    if (x.postType !== 'post') continue;
    let s = 0;
    for (const { t, scale } of titleToks) {
      if (x.titleLower.includes(t)) s += 3 * w(t) * scale;
      else if (x.plainLower.includes(t)) s += w(t) * scale;
    }
    if (bodyToks.length) {
      const xt = titleTokensOf(x);
      for (const { t, scale } of bodyToks) if (xt.has(t)) s += w(t) * scale;
    }
    if (s > 0) scored.push({ a: x, s });
  }
  scored.sort((p, q) => (q.s !== p.s ? q.s - p.s : (q.a.date || '') < (p.a.date || '') ? -1 : 1));

  // 上位から大きく離れたものは「たまたま語が重なっただけ」。足切りする。
  // 実データで測ると、無関係な文章は最高でも2点台、題材が重なる記事は10点以上に出る。
  if (!scored.length) return [];
  const floor = Math.max(scored[0].s * 0.2, 6);
  return scored.filter((x) => x.s >= floor).slice(0, limit);
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

  const hits = similarTo(titleText, bodyText, base ? base.id : -1, limit);
  const out = {
    basis: base ? { id: base.id, title: base.title, date: base.date } : { text_length: (titleText + bodyText).length },
    total_candidates: hits.length,
    results: hits.map((h) => {
      const d = summarize(h.a, null);
      d.score = Math.round(h.s * 10) / 10;
      return d;
    }),
  };
  if (!hits.length) {
    out.note = '近い記事は見つかりませんでした。同じ題材を扱った過去記事はない可能性が高いです。';
  } else if (hits[0].s < 15) {
    out.note =
      'スコアが低めです（題材がはっきり重なる場合は数十点になります）。' +
      '語がたまたま重なっただけの可能性があるため、本文を確認してから判断してください。';
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

  let list = library.articles.filter((a) => a.postType === 'post');
  if (args.date_from) list = list.filter((a) => a.date && a.date >= args.date_from);
  if (args.date_to) list = list.filter((a) => a.date && a.date <= args.date_to);
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

  const out = {
    query,
    total_matched: list.length,
    first: list.length ? list[0].date : null,
    last: list.length ? list[list.length - 1].date : null,
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
      '特定の時期を詳しく見るときは date_from / date_to で範囲を狭めてください。';
  }
  out.articles = picked.map((a) => ({ id: a.id, date: a.date, title: a.title || '(無題)' }));
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

  const out = {
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
      'タイトル・本文・カテゴリ・タグを部分一致で見る。既定では関連度順に並ぶ（珍しい語ほど、' +
      'またタイトルに含まれる記事ほど上位）。返るのは一覧（タイトル・日付・該当箇所の抜粋）で、本文は含まない。' +
      '本文が必要な記事だけを get_article で個別に取ること。' +
      '蔵書は1000本規模あるため、該当が多いときは全件を取ろうとせず、' +
      '検索語を具体的にするか date_from / date_to で絞る。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "検索語。例: 'Claude 移植'、'Swift OR SwiftUI'。空なら絞り込みのみ" },
        category: { type: 'string', description: 'カテゴリで絞り込む（部分一致）。蔵書に分類がある場合のみ有効' },
        tag: { type: 'string', description: 'タグで絞り込む（部分一致）。蔵書に分類がある場合のみ有効' },
        post_type: { type: 'string', description: 'post / page / all（既定: all）' },
        date_from: { type: 'string', description: 'この日以降 YYYY-MM-DD' },
        date_to: { type: 'string', description: 'この日以前 YYYY-MM-DD' },
        sort: { type: 'string', description: 'relevance（既定・検索語がある場合） / date（新しい順）' },
        limit: { type: 'integer', description: '最大件数（既定20、上限50）。多く取るほど文脈を消費するので、まず既定のまま試すこと' },
      },
    },
  },
  {
    name: 'find_similar',
    description:
      'ある文章に近い過去記事を探す。用途は2つ。' +
      '(1) これから書く記事の題材を text に渡して、同じネタを過去に書いていないか確認する。' +
      '(2) id / link で既存記事を渡して、関連記事や本文から張る自己引用リンクの候補を出す。' +
      '検索語を思いつく必要がないので、「この話、前に書いたっけ」の確認にはこちらを使う。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '下書きや企画メモの本文。数百字あれば十分' },
        title_text: { type: 'string', description: '想定タイトル（textと併用可）。タイトル由来の語は重く見る' },
        id: { type: 'integer', description: '基準にする記事のid' },
        link: { type: 'string', description: '基準にする記事のURL' },
        limit: { type: 'integer', description: '最大件数（既定10、上限30）' },
      },
    },
  },
  {
    name: 'topic_timeline',
    description:
      'ある話題について、いつ何を書いてきたかを古い順に並べ、月ごとの本数も返す。' +
      '「このテーマに自分はどう向き合ってきたか」「主張はいつ変わったか」を追うときに使う。' +
      '1件あたり日付とタイトルだけに切り詰めるので、search_articles より多くの記事を見渡せる。' +
      '該当が多い場合は期間全体が見えるよう間引いて返す。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "話題を表す検索語。例: 'Claude 料金'" },
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
