import Foundation

/// HTML版 htmlToMd() の移植
enum HTMLToMarkdown {

    static func convert(_ html: String, title: String, date: Date?) -> String {
        var md = ""
        if !title.isEmpty { md += "# \(title)\n\n" }
        if let d = date { md += "> \(Fmt.dateKey.string(from: d))\n\n---\n\n" }

        var b = html
        // 見出し h1-h5
        for level in 1...5 {
            b = replace(b, "<h\(level)[^>]*>(.*?)</h\(level)>") { m in
                "\n" + String(repeating: "#", count: level) + " " + m[1].trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n"
            }
        }
        b = replace(b, "<strong[^>]*>(.*?)</strong>") { "**\($0[1])**" }
        b = replace(b, "<b[^>]*>(.*?)</b>") { "**\($0[1])**" }
        b = replace(b, "<em[^>]*>(.*?)</em>") { "*\($0[1])*" }
        b = replace(b, "<i[^>]*>(.*?)</i>") { "*\($0[1])*" }
        b = replace(b, "<del[^>]*>(.*?)</del>") { "~~\($0[1])~~" }
        b = replace(b, "<a[^>]*href=\"([^\"]*)\"[^>]*>(.*?)</a>") { "[\($0[2])](\($0[1]))" }
        b = replace(b, "<img[^>]*src=\"([^\"]*)\"[^>]*alt=\"([^\"]*)\"[^>]*/?>") { "![\($0[2])](\($0[1]))" }
        b = replace(b, "<img[^>]*src=\"([^\"]*)\"[^>]*/?>") { "![](\($0[1]))" }
        b = replace(b, "<figure[^>]*>(.*?)</figure>") { "\n\($0[1])\n" }
        b = replace(b, "<figcaption[^>]*>(.*?)</figcaption>") { "*\($0[1])*\n" }
        b = replace(b, "<li[^>]*>(.*?)</li>") { "- \($0[1])\n" }
        b = replace(b, "</?[uo]l[^>]*>") { _ in "\n" }
        b = replace(b, "<blockquote[^>]*>(.*?)</blockquote>") { m in
            m[1].trimmingCharacters(in: .whitespacesAndNewlines)
                .components(separatedBy: "\n")
                .map { "> " + $0.trimmingCharacters(in: .whitespaces) }
                .joined(separator: "\n") + "\n\n"
        }
        b = replace(b, "<pre[^>]*><code[^>]*>(.*?)</code></pre>") { "\n```\n\($0[1])\n```\n\n" }
        b = replace(b, "<code[^>]*>(.*?)</code>") { "`\($0[1])`" }
        b = replace(b, "<br\\s*/?>") { _ in "\n" }
        b = replace(b, "<p[^>]*>(.*?)</p>") { "\($0[1])\n\n" }
        b = replace(b, "<hr[^>]*/?>") { _ in "\n---\n\n" }
        b = replace(b, "<div[^>]*>(.*?)</div>") { "\($0[1])\n" }
        b = replace(b, "<iframe[^>]*src=\"([^\"]*)\"[^>]*>.*?</iframe>") { "\n[埋め込み](\($0[1]))\n" }
        b = replace(b, "<[^>]*>") { _ in "" }

        b = b.replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&#x27;", with: "'")
        b = replace(b, "\n{3,}") { _ in "\n\n" }
        b = b.trimmingCharacters(in: .whitespacesAndNewlines)
        return md + b + "\n"
    }

    /// 正規表現の全マッチをクロージャで置換する。`m[i]` でキャプチャグループを参照。
    private static func replace(_ input: String, _ pattern: String,
                                using transform: ([String]) -> String) -> String {
        guard let re = try? NSRegularExpression(
            pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) else { return input }
        let ns = input as NSString
        let matches = re.matches(in: input, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return input }
        var out = ""
        var last = 0
        for m in matches {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            var groups: [String] = []
            for i in 0..<m.numberOfRanges {
                let r = m.range(at: i)
                groups.append(r.location == NSNotFound ? "" : ns.substring(with: r))
            }
            out += transform(groups)
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }
}
