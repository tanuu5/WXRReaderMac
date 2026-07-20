import SwiftUI
import WebKit
import AppKit

struct DetailView: View {
    @EnvironmentObject var state: AppState
    @State private var related: [Article] = []

    var body: some View {
        if let a = state.selected {
            content(for: a)
                .task(id: a.id) { await loadRelated(a) }
        }
    }

    /// 関連記事は全記事の本文走査で重いので、バックグラウンドで計算しキャッシュする。
    /// 詳細画面自体は即座に開き、関連記事は準備でき次第表示される。
    @MainActor
    private func loadRelated(_ a: Article) async {
        if let cached = state.relatedCache[a.id] { related = cached; return }
        related = []
        let arts = state.articles
        let r = await Task.detached(priority: .userInitiated) {
            Related.find(for: a, in: arts, max: 6)
        }.value
        state.relatedCache[a.id] = r
        if state.selected?.id == a.id { related = r }
    }

    private func content(for a: Article) -> some View {
        VStack(spacing: 0) {
            header(a)
            Divider().overlay(Theme.border)
            ArticleWebView(articleID: a.id, html: a.contentHTML, assetMap: state.assetMap)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if !related.isEmpty { relatedStrip(related) }
            Divider().overlay(Theme.border)
            bottomBar(a)
        }
    }

    // MARK: - Header

    private func header(_ a: Article) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                state.backToList()
            } label: {
                Text("← 一覧に戻る")
                    .font(.system(size: 12))
                    .foregroundColor(Theme.text3)
            }
            .buttonStyle(.plain)

            Text(a.title.isEmpty ? "(無題)" : a.title)
                .font(Theme.serif(24, bold: true))
                .foregroundColor(Theme.text)
                .lineSpacing(4)
                .textSelection(.enabled)

            HStack(spacing: 16) {
                Text("📅 \(a.dateString)")
                Text("📝 約\(a.wordCount.formatted())文字")
                Text("⏱ 約\(max(1, a.wordCount / 600))分")
                if a.status != "publish" {
                    Text("● \(a.status)").foregroundColor(Theme.accent)
                }
                if state.files.count > 1 {
                    Text("📁 \(a.sourceFile)")
                }
            }
            .font(.system(size: 12))
            .foregroundColor(Theme.text3)

            if !a.categories.isEmpty || !a.tags.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(a.categories, id: \.self) { TagChip(name: $0) }
                    ForEach(a.tags, id: \.self) { TagChip(name: $0, isTag: true) }
                }
            }
        }
        .frame(maxWidth: 960, alignment: .leading)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24).padding(.vertical, 16)
        .background(Theme.bg)
    }

    // MARK: - 関連記事

    private func relatedStrip(_ related: [Article]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("🔗 関連記事")
                .font(Theme.serif(13, bold: true))
                .foregroundColor(Theme.text2)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(related) { r in
                        Button {
                            state.select(r)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(r.title.isEmpty ? "(無題)" : r.title)
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundColor(Theme.text)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                                Text(r.dateString)
                                    .font(.system(size: 10))
                                    .foregroundColor(Theme.text3)
                            }
                            .padding(10)
                            .frame(width: 200, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bg))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.borderLight))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .frame(maxWidth: 960, alignment: .leading)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24).padding(.vertical, 10)
        .background(Theme.bg)
    }

    // MARK: - Bottom bar

    private func bottomBar(_ a: Article) -> some View {
        HStack(spacing: 8) {
            CtrlButton(title: "📋 MDコピー") {
                state.copyToClipboard(
                    HTMLToMarkdown.convert(a.contentHTML, title: a.title, date: a.date),
                    message: "Markdownをコピーしました")
            }
            CtrlButton(title: "🔖 HTMLコピー") {
                state.copyToClipboard(a.contentHTML, message: "HTMLをコピーしました")
            }
            CtrlButton(title: "💾 MD保存") { state.exportArticleMd(a) }
            if !a.link.isEmpty {
                CtrlButton(title: "🔗 URLコピー") {
                    state.copyToClipboard(a.link, message: "URLをコピーしました")
                }
                CtrlButton(title: "↗ noteで開く") {
                    if let url = URL(string: a.link) { NSWorkspace.shared.open(url) }
                }
            }
            Spacer()
            if let prev = state.prevArticle {
                CtrlButton(title: "← " + String((prev.title.isEmpty ? "前" : prev.title).prefix(18))) {
                    state.selectPrev()
                }
            }
            if let next = state.nextArticle {
                CtrlButton(title: String((next.title.isEmpty ? "次" : next.title).prefix(18)) + " →") {
                    state.selectNext()
                }
            }
            Text("j/k で移動")
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(Theme.text3)
        }
        .padding(.horizontal, 24).padding(.vertical, 12)
        .background(Theme.surface)
    }
}

// MARK: - 本文WebView

struct ArticleWebView: NSViewRepresentable {
    let articleID: Int
    let html: String
    let assetMap: [String: URL]

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        context.coordinator.assetHandler.assetMap = assetMap
        cfg.setURLSchemeHandler(context.coordinator.assetHandler, forURLScheme: "wxrasset")
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = context.coordinator
        wv.underPageBackgroundColor = NSColor(Theme.bg)
        return wv
    }

    func updateNSView(_ wv: WKWebView, context: Context) {
        guard context.coordinator.loadedID != articleID else { return }
        context.coordinator.loadedID = articleID
        context.coordinator.assetHandler.assetMap = assetMap
        wv.loadHTMLString(Self.wrap(rewriteAssets(html)), baseURL: nil)
    }

    /// src="/assets/xxx" → src="wxrasset:///xxx"
    private func rewriteAssets(_ html: String) -> String {
        guard !assetMap.isEmpty else { return html }
        guard let re = try? NSRegularExpression(
            pattern: "(src=[\"'])/assets/([^\"']+)([\"'])", options: [.caseInsensitive]) else { return html }
        let ns = html as NSString
        return re.stringByReplacingMatches(
            in: html, range: NSRange(location: 0, length: ns.length),
            withTemplate: "$1wxrasset:///$2$3")
    }

    private static func wrap(_ body: String) -> String {
        """
        <!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
        <style>
        body { font-family: 'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif;
               background: #F5F0E6; color: #1E1810; line-height: 2; font-size: 15px;
               margin: 0; padding: 32px 24px; }
        .sheet { max-width: 760px; margin: 0 auto; background: #FFFDF8;
                 border: 1px solid #EDE7DC; border-radius: 8px; padding: 40px 44px; }
        img { max-width: 100%; height: auto; border-radius: 4px; margin: 12px 0; }
        h1,h2,h3 { font-family: 'Hiragino Mincho ProN','Yu Mincho',serif; line-height: 1.4;
                   margin: 1.5em 0 .5em; }
        h1{font-size:1.5em} h2{font-size:1.3em} h3{font-size:1.15em}
        p { margin: .8em 0; }
        a { color: #6B8F71; text-decoration: underline; }
        blockquote { border-left: 3px solid #6B8F71; padding-left: 16px; margin: 1em 0;
                     color: #5C4F3E; font-style: italic; }
        pre { background: #F5F0E6; padding: 16px; border-radius: 8px; overflow-x: auto;
              font-size: .85em; line-height: 1.6; margin: 1em 0; }
        code { background: #F5F0E6; padding: 2px 6px; border-radius: 3px; font-size: .88em; }
        pre code { background: none; padding: 0; }
        ul,ol { padding-left: 1.5em; margin: .8em 0; }
        li { margin: .3em 0; }
        table { border-collapse: collapse; width: 100%; margin: 1em 0; }
        th,td { border: 1px solid #E2D9CB; padding: 8px 12px; text-align: left; font-size: .9em; }
        th { background: #F5F0E6; font-weight: 500; }
        figure { margin: 1em 0; }
        figcaption { font-size: .85em; color: #988B7A; }
        ::selection { background: #EBF2EC; }
        </style></head><body><div class="sheet">\(body)</div></body></html>
        """
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedID: Int? = nil
        let assetHandler = AssetSchemeHandler()

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // リンククリックは既定ブラウザで開く
            if navigationAction.navigationType == .linkActivated,
               let url = navigationAction.request.url,
               let scheme = url.scheme?.lowercased(),
               scheme == "http" || scheme == "https" {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}

/// wxrasset:///ファイル名 → ローカルassetsファイル
final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    var assetMap: [String: URL] = [:]

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        let name = url.lastPathComponent.removingPercentEncoding ?? url.lastPathComponent
        guard let fileURL = assetMap[name], let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(NSError(domain: "wxrasset", code: 404))
            return
        }
        let resp = URLResponse(url: url, mimeType: Self.mime(for: fileURL.pathExtension),
                               expectedContentLength: data.count, textEncodingName: nil)
        urlSchemeTask.didReceive(resp)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private static func mime(for ext: String) -> String {
        switch ext.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "heic": return "image/heic"
        case "mp4": return "video/mp4"
        case "mov": return "video/quicktime"
        default: return "application/octet-stream"
        }
    }
}
