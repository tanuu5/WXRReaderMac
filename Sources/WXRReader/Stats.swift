import Foundation

struct MonthStat: Identifiable {
    var key: String   // "2024-03"
    var count: Int
    var chars: Int
    var id: String { key }
}

struct BlogStats {
    var daily: [String: Int]      // "yyyy-MM-dd" → 投稿数
    var sortedDays: [String]
    var monthly: [MonthStat]      // 月順ソート済み
    var cats: [(name: String, count: Int)]
    var tags: [(name: String, count: Int)]
    var currentStreak: Int
    var longestStreak: Int
    var totalDays: Int
}

enum Stats {
    static func compute(_ articles: [Article]) -> BlogStats {
        let posts = articles.filter { $0.postType == "post" }
        var daily: [String: Int] = [:]
        var monthlyMap: [String: (count: Int, chars: Int)] = [:]
        var catMap: [String: Int] = [:], tagMap: [String: Int] = [:]

        for a in posts {
            for c in a.categories { catMap[c, default: 0] += 1 }
            for t in a.tags { tagMap[t, default: 0] += 1 }
            guard let d = a.date else { continue }
            daily[Fmt.dateKey.string(from: d), default: 0] += 1
            let mk = Fmt.monthKey.string(from: d)
            var m = monthlyMap[mk] ?? (0, 0)
            m.count += 1
            m.chars += a.wordCount
            monthlyMap[mk] = m
        }

        let sortedDays = daily.keys.sorted()
        let monthly = monthlyMap.keys.sorted().map {
            MonthStat(key: $0, count: monthlyMap[$0]!.count, chars: monthlyMap[$0]!.chars)
        }
        let cats = catMap.sorted { $0.value > $1.value }.map { (name: $0.key, count: $0.value) }
        let tags = tagMap.sorted { $0.value > $1.value }.map { (name: $0.key, count: $0.value) }

        // Streaks
        var current = 0, longest = 0
        if !sortedDays.isEmpty {
            let cal = Calendar.current
            // 現在の連続日数（今日から、なければ昨日から遡る）
            let todayKey = Fmt.dateKey.string(from: Date())
            var check = todayKey
            while daily[check] != nil { current += 1; check = shift(check, by: -1, cal) }
            if current == 0 {
                check = shift(todayKey, by: -1, cal)
                while daily[check] != nil { current += 1; check = shift(check, by: -1, cal) }
            }
            // 最長連続日数
            var streak = 1; longest = 1
            for i in 1..<sortedDays.count {
                if shift(sortedDays[i-1], by: 1, cal) == sortedDays[i] {
                    streak += 1
                    if streak > longest { longest = streak }
                } else { streak = 1 }
            }
        }

        return BlogStats(daily: daily, sortedDays: sortedDays, monthly: monthly,
                         cats: cats, tags: tags,
                         currentStreak: current, longestStreak: longest,
                         totalDays: sortedDays.count)
    }

    private static func shift(_ key: String, by days: Int, _ cal: Calendar) -> String {
        guard let d = Fmt.dateKey.date(from: key),
              let nd = cal.date(byAdding: .day, value: days, to: d) else { return "" }
        return Fmt.dateKey.string(from: nd)
    }
}

// MARK: - 関連記事

enum Related {
    /// HTML版 _getRelated の移植。
    /// カテゴリ・タグがあれば分類一致でスコアリング、なければタイトル/本文のトークン重複で算出。
    static func find(for a: Article, in articles: [Article], max: Int) -> [Article] {
        let catSet = Set(a.categories), tagSet = Set(a.tags)
        if !catSet.isEmpty || !tagSet.isEmpty {
            return articles
                .filter { $0.id != a.id && $0.postType == "post" }
                .compactMap { x -> (Article, Int)? in
                    var s = 0
                    for c in x.categories where catSet.contains(c) { s += 2 }
                    for t in x.tags where tagSet.contains(t) { s += 1 }
                    return s > 0 ? (x, s) : nil
                }
                .sorted { $0.1 > $1.1 }
                .prefix(max).map { $0.0 }
        }

        let titleToks = extractTokens(a.title)
        let bodyToks = extractTokens(String(a.plainLower.prefix(3000)))
        if titleToks.isEmpty { return [] }

        return articles
            .filter { $0.id != a.id && $0.postType == "post" }
            .compactMap { x -> (Article, Int)? in
                let xt = x.titleLower
                let xb = x.plainLower
                var s = 0
                for t in titleToks {
                    if xt.contains(t) { s += 3 } else if xb.contains(t) { s += 1 }
                }
                for t in bodyToks where xt.contains(t) { s += 1 }
                return s >= 3 ? (x, s) : nil
            }
            .sorted { $0.1 > $1.1 }
            .prefix(max).map { $0.0 }
    }

    /// CJK 2文字bigram + 英数字3文字以上のトークン抽出
    private static func extractTokens(_ text: String) -> Set<String> {
        var out = Set<String>()
        // 英数字トークン
        var word = ""
        func flushWord() {
            if word.count >= 3 { out.insert(word.lowercased()) }
            word = ""
        }
        // CJK連続文字列
        var run: [Character] = []
        func flushRun() {
            if run.count >= 2 {
                for i in 0..<(run.count - 1) {
                    out.insert(String(run[i]) + String(run[i+1]))
                }
            }
            run = []
        }
        for ch in text {
            let isAlnum = ch.isASCII && (ch.isLetter || ch.isNumber)
            var isCJK = false
            if let sc = ch.unicodeScalars.first {
                let v = sc.value
                // U+3000-9FFF（かな・カナ・漢字ほか）+ U+FF00-FFEF（全角英数）
                isCJK = (0x3000...0x9FFF).contains(v) || (0xFF00...0xFFEF).contains(v)
            }
            if isAlnum { word.append(ch) } else { flushWord() }
            if isCJK { run.append(ch) } else { flushRun() }
        }
        flushWord(); flushRun()
        return out
    }
}
