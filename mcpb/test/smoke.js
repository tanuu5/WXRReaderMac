#!/usr/bin/env node
/**
 * 書庫 MCP の動作確認。テスト用のWXRを一時フォルダに作り、サーバを起動して
 * JSON-RPC で一通り呼ぶ。Claude用（.mcpb）とChatGPT・Codex用（プラグイン）は同じサーバなので、これ1本で両方を確かめられる。
 *
 *   node mcpb/test/smoke.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.resolve(__dirname, '..', 'server', 'index.js');

const item = ({ title, link, date, type = 'post', status = 'publish', body }) => `
  <item>
    <title><![CDATA[${title}]]></title>
    <link>${link}</link>
    <wp:post_date><![CDATA[${date} 10:00:00]]></wp:post_date>
    <wp:post_type><![CDATA[${type}]]></wp:post_type>
    <wp:status><![CDATA[${status}]]></wp:status>
    <content:encoded><![CDATA[${body}]]></content:encoded>
  </item>`;

const wxr = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>テスト書庫</title>${items.join('')}
</channel>
</rss>`;

const A = {
  title: 'ClaudeとSwiftの記録', link: 'https://example.com/1', date: '2026-01-02',
  // 生の "<![CDATA[" を含む本文。以前はこれ以降の記事がすべて落ちていた
  body: '<p>ClaudeからSwiftアプリを作った記録です。</p>' +
    '<blockquote><p>引用</p></blockquote><p>一行目<br>二行目 <b>太字</b> <img src="a.png"> と <i>斜体</i></p>' +
    '<p>&amp;lt; と &#8217; と &quot;</p><p>CDATAは <![CDATA[ と書く。</p>',
};
const B = {
  title: 'ブログ検索の設計', link: 'https://example.com/2', date: '2026-02-03',
  body: '<p>WXRをローカルで検索する設計です。</p>',
};
const C = { title: '消した記事', link: 'https://example.com/3', date: '2026-02-10', status: 'trash', body: '<p>Swift</p>' };
const D = { title: '画像', link: 'https://example.com/4', date: '2026-02-11', type: 'attachment', body: '' };
const E = { title: '書きかけ', link: 'https://example.com/5', date: '2026-02-20', status: 'draft', body: '<p>ＳＷＩＦＴの下書き</p>' };

function startServer(dir) {
  const child = spawn(process.execPath, [SERVER], {
    // 設定ファイルや書庫アプリの設定を拾わないよう、読み込み先を環境変数で固定する
    env: { ...process.env, SHOKO_WXR_DIR: dir, SHOKO_CONFIG_PATH: path.join(dir, 'none.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  const orphans = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const cb = pending.get(message.id);
      if (cb) {
        pending.delete(message.id);
        cb(message);
      } else {
        orphans.push(message);
      }
    }
  });
  const waitFor = (id, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${label} timed out`));
    }, 5000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
  });
  const raw = (line, id) => {
    const p = waitFor(id, line);
    child.stdin.write(line + '\n');
    return p;
  };
  const request = (method, params) => {
    const id = nextId++;
    const p = waitFor(id, method);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  };
  const call = async (name, args = {}) => {
    const m = await request('tools/call', { name, arguments: args });
    if (m.error) return { error: m.error };
    const text = m.result.content[0].text;
    return m.result.isError ? { isError: true, text } : JSON.parse(text);
  };
  return { child, request, call, raw, orphans };
}

async function main() {
  // プラグイン側のサーバはコピー。直したのに写し忘れると ChatGPT・Codex だけ古いまま動く
  const pluginCopy = path.resolve(__dirname, '..', '..', 'plugins', 'shoko-chatgpt', 'server', 'index.js');
  assert.ok(fs.readFileSync(pluginCopy).equals(fs.readFileSync(SERVER)),
    'plugins/shoko-chatgpt/server/index.js が mcpb/server/index.js と違います。mcpb/pack.sh を実行するか、cp でコピーしてください');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shoko-test-'));
  const file = path.join(temp, 'backup.xml');
  fs.writeFileSync(file, wxr([A, B, C, D, E].map(item)));
  const srv = startServer(temp);

  try {
    // --- プロトコル
    const init = await srv.request('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.result.serverInfo.name, 'shoko');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const odd = await srv.request('initialize', { protocolVersion: '2099-01-01' });
    assert.equal(odd.result.protocolVersion, '2025-06-18', '知らない版はそのまま返さない');
    const nullParams = await srv.raw('{"jsonrpc":"2.0","id":900,"method":"tools/list","params":null}', 900);
    assert.ok(nullParams.result.tools, 'params: null でも応答する');
    const unknown = await srv.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);

    const listed = await srv.request('tools/list');
    assert.deepEqual(listed.result.tools.map((t) => t.name),
      ['library_info', 'search_articles', 'find_similar', 'topic_timeline', 'get_article']);
    assert(listed.result.tools.every((t) => t.annotations.readOnlyHint === true));

    // --- 読み込み（CDATA・ゴミ箱・添付）
    const info = await srv.call('library_info');
    assert.equal(info.article_count, 3, '本文に <![CDATA[ があっても後続を落とさず、trash と attachment は除く');
    assert.deepEqual(info.statuses, { publish: 2, draft: 1 });
    assert.equal(info.data_location, 'local');
    assert.equal(info.wxr_dir, undefined, 'フルパス（ユーザー名を含む）を会話に出さない');

    // --- 検索
    const s1 = await srv.call('search_articles', { query: 'Claude Swift' });
    assert.equal(s1.total_matched, 1);
    const swift = await srv.call('search_articles', { query: 'swift' });
    assert.deepEqual(swift.results.map((r) => r.title).sort(), ['ClaudeとSwiftの記録', '書きかけ'],
      '全角のＳＷＩＦＴも拾い、ゴミ箱の記事は出さない');
    assert.equal(swift.results.find((r) => r.title === '書きかけ').status, 'draft');
    const onlyOr = await srv.call('search_articles', { query: 'OR' });
    assert.ok(onlyOr.isError, 'OR だけの検索は全件を返さずエラーにする');

    // --- 期間指定（年月だけでもその月を含める）
    const feb = await srv.call('search_articles', { date_from: '2026-02', date_to: '2026-02' });
    assert.deepEqual(feb.results.map((r) => r.date).sort(), ['2026-02-03', '2026-02-20']);
    const year = await srv.call('search_articles', { date_to: '2026' });
    assert.equal(year.total_matched, 3);
    const bad = await srv.call('search_articles', { date_from: '去年' });
    assert.ok(bad.isError);

    // --- 本文とMarkdown
    const art = await srv.call('get_article', { id: s1.results[0].id });
    assert.match(art.content, /> 引用/);
    assert.match(art.content, /\*\*太字\*\*/);
    assert.match(art.content, /!\[\]\(a\.png\)/, '<img> を斜体と取り違えない');
    assert.match(art.content, /一行目\n二行目/);
    const text = await srv.call('get_article', { id: s1.results[0].id, format: 'text' });
    assert.match(text.content, /&lt; と ’ と "/, '&amp;lt; は &lt; まで、数値参照も戻す');
    assert.doesNotMatch(text.content, /引用一行目/, '段落の語どうしをくっつけない');

    // --- idはバックアップを入れ替えても変わらない
    const idBefore = s1.results[0].id;
    const idB = (await srv.call('search_articles', { query: '設計' })).results[0].id;
    fs.writeFileSync(path.join(temp, 'a-newer.xml'),
      wxr([item({ title: '新しい記事', link: 'https://example.com/9', date: '2026-03-01', body: '<p>new</p>' })]));
    const after = await srv.call('search_articles', { query: 'Claude Swift' });
    assert.equal(after.results[0].id, idBefore);
    assert.equal((await srv.call('get_article', { id: idB })).title, 'ブログ検索の設計');

    // --- 時系列・類似
    const tl = await srv.call('topic_timeline', { query: 'Swift' });
    assert.equal(tl.first, '2026-01-02');
    const sim = await srv.call('find_similar', { id: idB });
    assert.ok(Array.isArray(sim.results));

    // --- 壊れた行には parse error を返す
    const errLine = new Promise((resolve) => {
      const t = setInterval(() => {
        const m = srv.orphans.find((x) => x.error && x.error.code === -32700);
        if (m) {
          clearInterval(t);
          resolve(m);
        }
      }, 20);
    });
    srv.child.stdin.write('{not json\n');
    await errLine;
  } finally {
    srv.child.kill();
    if (temp.startsWith(os.tmpdir())) fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('MCP smoke test passed');
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
