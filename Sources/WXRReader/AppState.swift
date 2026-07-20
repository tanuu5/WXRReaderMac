import SwiftUI
import AppKit

enum Phase { case landing, parsing, list }

/// アプリ全体の状態。UI操作はすべてメインスレッドから呼ばれる前提。
/// 解析・一括エクスポートのみバックグラウンドで実行し、UI更新はmainへdispatchする。
final class AppState: ObservableObject {
    /// AppDelegate（Spotlight連携）とSwiftUIの両方から参照する共有インスタンス
    static let shared = AppState()

    // 画面状態
    @Published var phase: Phase = .landing
    @Published var selected: Article? = nil
    @Published var showStats = true
    @Published var showHelp = false

    // データ
    @Published var articles: [Article] = []
    @Published var filtered: [Article] = []
    @Published var channelTitle = "ブログアーカイブ"
    @Published var stats: BlogStats? = nil

    // フィルタ
    @Published var query = "" { didSet { if query != oldValue { scheduleFilter() } } }
    @Published var sortDesc = true { didSet { applyFilters() } }
    @Published var typeFilter = "post" { didSet { applyFilters() } }

    // 解析進捗
    @Published var parseProgress = 0.0
    @Published var parseCount = 0
    @Published var parseFileLabel = ""
    @Published var parseStart = Date()

    // エクスポート進捗（nil以外で進行中シート表示）
    @Published var exportProgress: Double? = nil

    // その他
    @Published var toastMessage: String? = nil
    @Published var searchFocusRequest = 0

    var files: [URL] = []
    var totalBytes: Int64 = 0
    var assetMap: [String: URL] = [:]
    var relatedCache: [Int: [Article]] = [:]  // 記事ID → 関連記事（メインスレッドから読み書き）
    private var spotlightMap: [String: Int] = [:]  // Spotlight識別子 → 記事ID
    private var pendingSpotlightID: String? = nil  // 起動直後にSpotlightから来た場合の保留

    private var parseTask: Task<Void, Never>? = nil
    private var filterWork: DispatchWorkItem? = nil
    private var toastWork: DispatchWorkItem? = nil

    var lastFolderPath: String? {
        get { UserDefaults.standard.string(forKey: "lastFolder") }
        set { UserDefaults.standard.set(newValue, forKey: "lastFolder") }
    }
    var lastFolderName: String? {
        lastFolderPath.map { URL(fileURLWithPath: $0).lastPathComponent }
    }

    var postCount: Int { articles.filter { $0.postType == "post" }.count }
    var pageCount: Int { articles.filter { $0.postType == "page" }.count }

    var dateRangeLabel: String {
        let dates = articles.filter { $0.postType == "post" }.compactMap { $0.date }.sorted()
        guard let first = dates.first, let last = dates.last else { return "—" }
        if dates.count == 1 { return Fmt.dateKey.string(from: first) }
        return "\(Fmt.dateKey.string(from: first)) 〜 \(Fmt.dateKey.string(from: last))"
    }
    var totalChars: Int { articles.filter { $0.postType == "post" }.reduce(0) { $0 + $1.wordCount } }
    var totalMB: Double { Double(totalBytes) / (1024 * 1024) }

    // MARK: - フォルダ選択・読み込み

    func openFolderPanel() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.prompt = "このフォルダを読む"
        p.message = "バックアップフォルダ（XMLを含む）を選択"
        if p.runModal() == .OK, let url = p.url { loadFolder(url) }
    }

    func restoreLastFolder() {
        guard let path = lastFolderPath else { return }
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue {
            loadFolder(URL(fileURLWithPath: path))
        } else {
            toast("前回のフォルダが見つかりません")
            lastFolderPath = nil
            objectWillChange.send()
        }
    }

    func forgetFolder() {
        lastFolderPath = nil
        objectWillChange.send()
    }

    func loadFolder(_ url: URL) {
        let xmls = Self.collectXMLs(in: url)
        guard !xmls.isEmpty else { toast("XMLファイルが見つかりません"); return }
        lastFolderPath = url.path
        assetMap = Self.buildAssetMap(in: url)
        files = xmls
        totalBytes = xmls.reduce(Int64(0)) {
            $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        startParsing()
    }

    /// フォルダ直下 + サブフォルダ1階層のXMLを収集（ファイル名で重複除去、ja順ソート）
    static func collectXMLs(in folder: URL) -> [URL] {
        let fm = FileManager.default
        var found: [URL] = []
        let opts: FileManager.DirectoryEnumerationOptions = [.skipsHiddenFiles]
        guard let entries = try? fm.contentsOfDirectory(
            at: folder, includingPropertiesForKeys: [.isDirectoryKey], options: opts) else { return [] }
        for entry in entries {
            let isDir = (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if isDir {
                let subs = (try? fm.contentsOfDirectory(
                    at: entry, includingPropertiesForKeys: nil, options: opts)) ?? []
                for f in subs where f.pathExtension.lowercased() == "xml" { found.append(f) }
            } else if entry.pathExtension.lowercased() == "xml" {
                found.append(entry)
            }
        }
        var seen = Set<String>()
        found = found.filter { seen.insert($0.lastPathComponent).inserted }
        return found.sorted {
            $0.lastPathComponent.compare($1.lastPathComponent, options: [],
                                         range: nil, locale: Locale(identifier: "ja")) == .orderedAscending
        }
    }

    /// 各サブフォルダの assets/ 内ファイル名 → URL（先勝ち）
    static func buildAssetMap(in folder: URL) -> [String: URL] {
        let fm = FileManager.default
        var map: [String: URL] = [:]
        let opts: FileManager.DirectoryEnumerationOptions = [.skipsHiddenFiles]
        var candidates: [URL] = [folder.appendingPathComponent("assets")]
        if let entries = try? fm.contentsOfDirectory(
            at: folder, includingPropertiesForKeys: [.isDirectoryKey], options: opts) {
            for entry in entries {
                let isDir = (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
                if isDir { candidates.append(entry.appendingPathComponent("assets")) }
            }
        }
        for dir in candidates {
            guard let items = try? fm.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil, options: opts) else { continue }
            for f in items where map[f.lastPathComponent] == nil {
                map[f.lastPathComponent] = f
            }
        }
        return map
    }

    // MARK: - 解析

    func startParsing() {
        parseTask?.cancel()
        phase = .parsing
        parseProgress = 0; parseCount = 0
        parseStart = Date()
        parseFileLabel = ""
        articles = []; filtered = []; stats = nil; selected = nil
        relatedCache = [:]
        let fileURLs = files

        parseTask = Task.detached(priority: .userInitiated) {
            var all: [Article] = []
            var channel: String? = nil
            let total = fileURLs.count
            for (i, f) in fileURLs.enumerated() {
                if Task.isCancelled { return }
                let data = (try? Data(contentsOf: f)) ?? Data()
                let text = String(decoding: data, as: UTF8.self)
                let base = all.count
                let result = WXRParser.parse(text: text, sourceFile: f.lastPathComponent) { frac, cnt in
                    let p = (Double(i) + frac) / Double(max(total, 1))
                    let c = base + cnt
                    let label = "ファイル \(i + 1) / \(total)：\(f.lastPathComponent)"
                    DispatchQueue.main.async {
                        guard self.phase == .parsing else { return }
                        self.parseProgress = p
                        self.parseCount = c
                        self.parseFileLabel = label
                    }
                }
                if channel == nil { channel = result.channelTitle }
                all.append(contentsOf: result.articles)
            }
            if Task.isCancelled { return }
            var indexed: [Article] = []
            indexed.reserveCapacity(all.count)
            for (i, a) in all.enumerated() { var x = a; x.id = i; indexed.append(x) }
            let st = Stats.compute(indexed)
            let ch = channel
            DispatchQueue.main.async {
                guard self.phase == .parsing else { return }
                self.articles = indexed
                if let ch, !ch.isEmpty { self.channelTitle = ch }
                self.stats = st
                self.applyFilters()
                self.phase = .list
                // Spotlight索引（識別子→記事IDの逆引きも構築）
                self.spotlightMap = Dictionary(
                    indexed.map { (SpotlightIndexer.stableID(for: $0), $0.id) },
                    uniquingKeysWith: { a, _ in a })
                if let pending = self.pendingSpotlightID {
                    self.pendingSpotlightID = nil
                    if let idx = self.spotlightMap[pending] { self.selected = self.articles[idx] }
                }
                DispatchQueue.global(qos: .utility).async {
                    SpotlightIndexer.reindex(indexed)
                }
            }
        }
    }

    func cancelParse() {
        parseTask?.cancel()
        phase = .landing
    }

    // MARK: - 検索・フィルタ

    private func scheduleFilter() {
        filterWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.applyFilters() }
        filterWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: w)
    }

    func applyFilters() {
        var list = articles
        if typeFilter != "all" { list = list.filter { $0.postType == typeFilter } }
        let q = query.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty {
            // スペース区切り=AND、"OR"（単語）=OR
            let orGroups = Self.splitOR(q)
                .map { $0.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init) }
                .filter { !$0.isEmpty }
            if !orGroups.isEmpty {
                list = list.filter { a in
                    orGroups.contains { group in group.allSatisfy { a.matches($0) } }
                }
            }
        }
        list.sort { l, r in
            let ld = l.date ?? .distantPast, rd = r.date ?? .distantPast
            if ld == rd { return l.id < r.id }
            return sortDesc ? ld > rd : ld < rd
        }
        filtered = list
        // 選択中の記事がフィルタ外になっても詳細表示は維持（HTML版と同挙動）
    }

    static func splitOR(_ s: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: "\\bOR\\b", options: [.caseInsensitive]) else { return [s] }
        let ns = s as NSString
        var parts: [String] = []
        var last = 0
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            parts.append(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
            last = m.range.location + m.range.length
        }
        parts.append(ns.substring(from: last))
        return parts
    }

    func filterByTag(_ tag: String) {
        query = tag
        applyFilters()
    }

    // MARK: - Spotlight

    /// Spotlightの検索結果クリックで呼ばれる。
    /// データ読み込み済みなら該当記事へ直行、未読み込みなら前回フォルダを自動で開いてから飛ぶ。
    func openFromSpotlight(_ identifier: String) {
        if !articles.isEmpty {
            if let idx = spotlightMap[identifier] {
                selected = articles[idx]
            } else {
                toast("記事が見つかりません（バックアップが変わった可能性）")
            }
            return
        }
        pendingSpotlightID = identifier
        if phase == .landing {
            if lastFolderPath != nil {
                restoreLastFolder()
            } else {
                toast("先にバックアップフォルダを開いてください")
            }
        }
    }

    // MARK: - ナビゲーション

    func select(_ a: Article) { selected = a }
    func backToList() { selected = nil }

    func selectNext() {
        guard let cur = selected,
              let pos = filtered.firstIndex(where: { $0.id == cur.id }),
              pos < filtered.count - 1 else { return }
        selected = filtered[pos + 1]
    }
    func selectPrev() {
        guard let cur = selected,
              let pos = filtered.firstIndex(where: { $0.id == cur.id }),
              pos > 0 else { return }
        selected = filtered[pos - 1]
    }
    var prevArticle: Article? {
        guard let cur = selected,
              let pos = filtered.firstIndex(where: { $0.id == cur.id }), pos > 0 else { return nil }
        return filtered[pos - 1]
    }
    var nextArticle: Article? {
        guard let cur = selected,
              let pos = filtered.firstIndex(where: { $0.id == cur.id }),
              pos < filtered.count - 1 else { return nil }
        return filtered[pos + 1]
    }

    // MARK: - キーボード（NSEventローカルモニタから呼ばれる。常にメインスレッド）

    /// true を返したらイベントを消費
    func handleKey(_ e: NSEvent) -> Bool {
        if showHelp { return false }  // シート表示中はシステムに任せる
        let editing = (NSApp.keyWindow?.firstResponder as? NSTextView)?.isFieldEditor ?? false

        if e.keyCode == 53 { // Esc
            if selected != nil { selected = nil; return true }
            if !query.isEmpty { query = ""; applyFilters(); return true }
            return false
        }
        if editing { return false }
        guard e.modifierFlags.intersection([.command, .option, .control]).isEmpty,
              let ch = e.charactersIgnoringModifiers else { return false }
        switch ch {
        case "/":
            if phase == .list && selected == nil { searchFocusRequest += 1; return true }
        case "j":
            if selected != nil { selectNext(); return true }
        case "k":
            if selected != nil { selectPrev(); return true }
        default: break
        }
        return false
    }

    // MARK: - エクスポート

    func exportArticleMd(_ a: Article) {
        let p = NSSavePanel()
        p.nameFieldStringValue = a.mdFileName
        guard p.runModal() == .OK, let url = p.url else { return }
        let md = HTMLToMarkdown.convert(a.contentHTML, title: a.title, date: a.date)
        do {
            try md.write(to: url, atomically: true, encoding: .utf8)
            toast("💾 保存しました")
        } catch { toast("保存に失敗しました") }
    }

    func batchExportMd() {
        let targets = filtered.filter { $0.postType == "post" || $0.postType == "page" }
        guard !targets.isEmpty else { toast("対象なし"); return }
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.canCreateDirectories = true
        p.prompt = "ここに保存"
        p.message = "\(targets.count)件のMarkdownを保存するフォルダを選択"
        guard p.runModal() == .OK, let dir = p.url else { return }
        exportProgress = 0
        Task.detached(priority: .userInitiated) {
            var ok = 0
            for (i, a) in targets.enumerated() {
                let md = HTMLToMarkdown.convert(a.contentHTML, title: a.title, date: a.date)
                let url = dir.appendingPathComponent(a.mdFileName)
                if (try? md.write(to: url, atomically: true, encoding: .utf8)) != nil { ok += 1 }
                if i % 10 == 0 {
                    let prog = Double(i + 1) / Double(targets.count)
                    DispatchQueue.main.async { self.exportProgress = prog }
                }
            }
            let done = ok
            let total = targets.count
            DispatchQueue.main.async {
                self.exportProgress = nil
                self.toast("\(done)件を保存しました" + (done < total ? "（\(total - done)件失敗）" : ""))
            }
        }
    }

    func exportCSV() {
        let p = NSSavePanel()
        p.nameFieldStringValue = "blog_articles.csv"
        guard p.runModal() == .OK, let url = p.url else { return }
        let header = ["タイトル", "公開日", "種別", "ステータス", "文字数", "カテゴリ", "タグ", "リンク", "ソースファイル"]
        var lines = [header.map(csvEscape).joined(separator: ",")]
        for a in filtered {
            lines.append([
                a.title, a.dateString, a.postType, a.status, String(a.wordCount),
                a.categories.joined(separator: "; "), a.tags.joined(separator: "; "),
                a.link, a.sourceFile
            ].map(csvEscape).joined(separator: ","))
        }
        let csv = "\u{FEFF}" + lines.joined(separator: "\n")
        do {
            try csv.write(to: url, atomically: true, encoding: .utf8)
            toast("CSVを保存しました")
        } catch { toast("保存に失敗しました") }
    }

    private func csvEscape(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }

    // MARK: - クリップボード・トースト

    func copyToClipboard(_ s: String, message: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        toast(message)
    }

    func toast(_ msg: String) {
        toastMessage = msg
        toastWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.toastMessage = nil }
        toastWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.8, execute: w)
    }
}
