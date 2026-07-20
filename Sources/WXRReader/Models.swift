import Foundation

struct Article: Identifiable, Hashable {
    var id: Int = 0
    var title: String
    var titleLower: String
    var link: String
    var date: Date?
    var postType: String   // "post" / "page" / ...
    var status: String     // "publish" etc.
    var excerpt: String
    var contentHTML: String
    var plainLower: String // 検索・関連記事用（本文プレーンテキスト小文字）
    var wordCount: Int
    var categories: [String]
    var tags: [String]
    var sourceFile: String

    // 検索対象: タイトル + 本文 + カテゴリ + タグ（termは小文字前提）
    func matches(_ term: String) -> Bool {
        if titleLower.contains(term) { return true }
        if plainLower.contains(term) { return true }
        if categories.contains(where: { $0.lowercased().contains(term) }) { return true }
        if tags.contains(where: { $0.lowercased().contains(term) }) { return true }
        return false
    }

    var dateString: String {
        guard let d = date else { return "—" }
        return Fmt.dateKey.string(from: d)
    }

    var mdFileName: String {
        let pfx: String
        if let d = date {
            pfx = Fmt.dateKey.string(from: d).replacingOccurrences(of: "-", with: "") + "_"
        } else { pfx = "" }
        return pfx + Self.sanitize(title.isEmpty ? "article" : title) + ".md"
    }

    static func sanitize(_ s: String) -> String {
        var out = ""
        for ch in s {
            if "\\/:*?\"<>|\n\r\t".contains(ch) { out.append("_") } else { out.append(ch) }
        }
        return String(out.prefix(80))
    }

    static func == (l: Article, r: Article) -> Bool { l.id == r.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// 共有DateFormatter
enum Fmt {
    static let dateKey: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
    static let monthKey: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
    static let wpDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
    static let rfc822: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss Z"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
}
