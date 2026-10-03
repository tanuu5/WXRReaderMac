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
    var dayStreak: Streak         // 毎日の連続
    var weekStreak: Streak        // 毎週の連続（日曜始まり。ヒートマップの列と同じ区切り）
    var totalDays: Int
    var totalWeeks: Int
}

struct Streak {
    var current = 0
    var longest = 0
    var longestFrom: String? = nil   // 最長連続の最初の投稿日 "yyyy-MM-dd"
    var longestTo: String? = nil     // 最長連続の最後の投稿日
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
        let cal = Calendar.current
        let todayKey = Fmt.dateKey.string(from: Date())
        let dayStreak = streak(keys: sortedDays, step: 1, anchor: todayKey,
                               firstDay: { $0 }, lastDay: { $0 }, cal)

        // 週ごとに、その週の最初と最後の投稿日をまとめる
        var weekFirst: [String: String] = [:], weekLast: [String: String] = [:]
        for day in sortedDays {
            guard let wk = weekStart(day, cal) else { continue }
            if weekFirst[wk] == nil { weekFirst[wk] = day }
            weekLast[wk] = day
        }
        let weekKeys = weekFirst.keys.sorted()
        let weekStreak = streak(keys: weekKeys, step: 7, anchor: weekStart(todayKey, cal) ?? todayKey,
                                firstDay: { weekFirst[$0] ?? $0 }, lastDay: { weekLast[$0] ?? $0 }, cal)

        return BlogStats(daily: daily, sortedDays: sortedDays, monthly: monthly,
                         cats: cats, tags: tags,
                         dayStreak: dayStreak, weekStreak: weekStreak,
                         totalDays: sortedDays.count, totalWeeks: weekKeys.count)
    }

    /// keys（昇順・重複なし）が step 日おきに続く区間の長さを数える。
    /// 現在の連続は anchor（今日／今週）から遡る。anchor に投稿がなければ一つ前から数える
    /// （今日まだ書いていないだけで連続が0に見えないように）。
    private static func streak(keys: [String], step: Int, anchor: String,
                               firstDay: (String) -> String, lastDay: (String) -> String,
                               _ cal: Calendar) -> Streak {
        guard !keys.isEmpty else { return Streak() }
        let set = Set(keys)
        var out = Streak()

        var check = set.contains(anchor) ? anchor : shift(anchor, by: -step, cal)
        while set.contains(check) { out.current += 1; check = shift(check, by: -step, cal) }

        var runStart = 0, bestStart = 0, bestEnd = 0
        for i in 1..<keys.count where shift(keys[i-1], by: step, cal) != keys[i] {
            if i - runStart > bestEnd - bestStart + 1 { bestStart = runStart; bestEnd = i - 1 }
            runStart = i
        }
        if keys.count - runStart > bestEnd - bestStart + 1 { bestStart = runStart; bestEnd = keys.count - 1 }
        out.longest = bestEnd - bestStart + 1
        out.longestFrom = firstDay(keys[bestStart])
        out.longestTo = lastDay(keys[bestEnd])
        return out
    }

    /// その日を含む週の日曜日 "yyyy-MM-dd"
    private static func weekStart(_ key: String, _ cal: Calendar) -> String? {
        guard let d = Fmt.dateKey.date(from: key) else { return nil }
        let offset = cal.component(.weekday, from: d) - 1   // 日曜=1
        guard let sunday = cal.date(byAdding: .day, value: -offset, to: d) else { return nil }
        return Fmt.dateKey.string(from: sunday)
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
