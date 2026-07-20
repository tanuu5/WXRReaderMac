import Foundation

/// WXR (WordPress eXtended RSS) パーサー。
/// HTML版と同じ方針: 整形式XMLに依存せず、CDATAを考慮した文字列走査で <item> を抽出する。
enum WXRParser {

    struct Result {
        var channelTitle: String?
        var channelLink: String?
        var articles: [Article]
    }

    /// - Parameters:
    ///   - onProgress: (ファイル内進捗0-1, 検出記事数)。適度に間引いて呼ばれる。
    static func parse(text: String, sourceFile: String,
                      onProgress: (Double, Int) -> Void) -> Result {
        let ns = text as NSString
        let len = ns.length
        var articles: [Article] = []
        var channelTitle: String? = nil
        var channelLink: String? = nil
        var pos = 0
        var lastReported = 0

        while pos < len {
            if Task.isCancelled { break }
            let searchRange = NSRange(location: pos, length: len - pos)
            let open = ns.range(of: "<item>", options: [], range: searchRange)
            if open.location == NSNotFound { break }

            // channel情報は最初の<item>より前から抽出
            if channelTitle == nil && articles.isEmpty {
                let head = ns.substring(with: NSRange(location: 0, length: open.location))
                channelTitle = tagContent("title", in: head).map(unwrapCDATA)
                channelLink = tagContent("link", in: head).map(unwrapCDATA)
            }

            guard let closeLoc = findItemEnd(ns, itemBodyStart: open.location + 6, totalLength: len) else { break }
            let itemStr = ns.substring(with: NSRange(location: open.location,
                                                     length: closeLoc + 7 - open.location))
            if let a = parseItem(itemStr, sourceFile: sourceFile) {
                articles.append(a)
            }
            pos = closeLoc + 7

            if articles.count - lastReported >= 50 {
                lastReported = articles.count
                onProgress(Double(pos) / Double(max(len, 1)), articles.count)
            }
        }
        onProgress(1.0, articles.count)
        return Result(channelTitle: channelTitle, channelLink: channelLink, articles: articles)
    }

    /// CDATA内の "</item>" を誤検出しないよう、CDATA開閉数を照合して真の終端を探す
    private static func findItemEnd(_ ns: NSString, itemBodyStart: Int, totalLength: Int) -> Int? {
        var searchFrom = itemBodyStart
        while searchFrom < totalLength {
            let r = ns.range(of: "</item>", options: [],
                             range: NSRange(location: searchFrom, length: totalLength - searchFrom))
            if r.location == NSNotFound { return nil }
            let seg = NSRange(location: itemBodyStart, length: r.location - itemBodyStart)
            let opens = countOccurrences(ns, of: "<![CDATA[", in: seg)
            let closes = countOccurrences(ns, of: "]]>", in: seg)
            if opens <= closes { return r.location }
            searchFrom = r.location + 7
        }
        return nil
    }

    private static func countOccurrences(_ ns: NSString, of needle: String, in range: NSRange) -> Int {
        var count = 0
        var loc = range.location
        let end = range.location + range.length
        while loc < end {
            let r = ns.range(of: needle, options: [], range: NSRange(location: loc, length: end - loc))
            if r.location == NSNotFound { break }
            count += 1
            loc = r.location + r.length
        }
        return count
    }

    // MARK: - Item

    private static func parseItem(_ item: String, sourceFile: String) -> Article? {
        let title = unwrapCDATA(tagContent("title", in: item) ?? "")
        let link = unwrapCDATA(tagContent("link", in: item) ?? "")
        let pubDateStr = tagContent("pubDate", in: item) ?? ""
        let postDateStr = tagContent("wp:post_date", in: item).map(unwrapCDATA) ?? ""
        let postType = tagContent("wp:post_type", in: item).map(unwrapCDATA) ?? "post"
        let status = tagContent("wp:status", in: item).map(unwrapCDATA) ?? "publish"

        let content = contentEncoded(in: item)
        let plain = stripHTML(content)

        var cats: [String] = [], tags: [String] = []
        extractTaxonomy(item, cats: &cats, tags: &tags)

        var date: Date? = nil
        if !postDateStr.isEmpty { date = Fmt.wpDate.date(from: postDateStr) }
        if date == nil, !pubDateStr.isEmpty { date = Fmt.rfc822.date(from: pubDateStr) }

        return Article(
            title: title, titleLower: title.lowercased(), link: link, date: date,
            postType: postType, status: status,
            excerpt: String(plain.prefix(400)).trimmingCharacters(in: .whitespacesAndNewlines),
            contentHTML: content,
            plainLower: plain.lowercased(),
            wordCount: plain.count,
            categories: cats, tags: tags,
            sourceFile: sourceFile
        )
    }

    private static func contentEncoded(in item: String) -> String {
        guard let openStart = item.range(of: "<content:encoded>") else { return "" }
        // CDATA本文中の "]]>" 単独ではなく "]]></content:encoded>" を優先して探す（HTML版と同方針）
        if let cdOpen = item.range(of: "<![CDATA[", range: openStart.upperBound..<item.endIndex),
           let cdClose = item.range(of: "]]></content:encoded>", range: cdOpen.upperBound..<item.endIndex) {
            return String(item[cdOpen.upperBound..<cdClose.lowerBound])
        }
        if let close = item.range(of: "</content:encoded>", range: openStart.upperBound..<item.endIndex) {
            return unwrapCDATA(String(item[openStart.upperBound..<close.lowerBound]))
        }
        return ""
    }

    private static let taxonomyRegex = try! NSRegularExpression(
        pattern: "<category\\s+domain=\"(category|post_tag)\"[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</category>",
        options: [.dotMatchesLineSeparators])

    private static func extractTaxonomy(_ item: String, cats: inout [String], tags: inout [String]) {
        let ns = item as NSString
        let matches = taxonomyRegex.matches(in: item, range: NSRange(location: 0, length: ns.length))
        for m in matches {
            guard m.numberOfRanges >= 3 else { continue }
            let domain = ns.substring(with: m.range(at: 1))
            let name = ns.substring(with: m.range(at: 2)).trimmingCharacters(in: .whitespacesAndNewlines)
            if name.isEmpty { continue }
            if domain == "category" { cats.append(name) } else { tags.append(name) }
        }
    }

    // MARK: - Helpers

    /// "<name ...>内容</name>" の内容を返す（最初の出現）
    static func tagContent(_ name: String, in s: String) -> String? {
        guard let openStart = s.range(of: "<\(name)") else { return nil }
        guard let openEnd = s.range(of: ">", range: openStart.upperBound..<s.endIndex) else { return nil }
        guard let close = s.range(of: "</\(name)>", range: openEnd.upperBound..<s.endIndex) else { return nil }
        return String(s[openEnd.upperBound..<close.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func unwrapCDATA(_ t: String) -> String {
        guard let r1 = t.range(of: "<![CDATA[") else { return t }
        guard let r2 = t.range(of: "]]>", options: .backwards), r1.upperBound <= r2.lowerBound else { return t }
        return String(t[r1.upperBound..<r2.lowerBound])
    }

    private static let tagStripRegex = try! NSRegularExpression(pattern: "<[^>]*>", options: [])

    static func stripHTML(_ html: String) -> String {
        if html.isEmpty { return "" }
        let ns = html as NSString
        var out = tagStripRegex.stringByReplacingMatches(
            in: html, range: NSRange(location: 0, length: ns.length), withTemplate: "")
        out = out.replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
        return out
    }
}
