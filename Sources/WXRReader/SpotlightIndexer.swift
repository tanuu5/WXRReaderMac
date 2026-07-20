import Foundation
import CoreSpotlight
import UniformTypeIdentifiers

/// Core Spotlight への記事索引。
/// macOSのSpotlight検索（⌘Space）から記事を直接開けるようにする。
/// 索引はローカルのみで、外部送信は一切ない。
enum SpotlightIndexer {
    static let domain = "com.tanu.wxr-reader.articles"

    /// 再起動をまたいで安定する識別子（リンクがあればリンク、なければ複合キー）
    static func stableID(for a: Article) -> String {
        if !a.link.isEmpty { return a.link }
        return a.sourceFile + "|" + a.dateString + "|" + a.title
    }

    /// 既存索引を全削除して作り直す（フォルダ読み込み完了時に呼ぶ）
    static func reindex(_ articles: [Article]) {
        let index = CSSearchableIndex.default()
        index.deleteSearchableItems(withDomainIdentifiers: [domain]) { _ in
            let items = articles
                .filter { $0.postType == "post" || $0.postType == "page" }
                .map { a -> CSSearchableItem in
                    let attr = CSSearchableItemAttributeSet(contentType: .text)
                    attr.title = a.title.isEmpty ? "(無題)" : a.title
                    attr.contentDescription = String(a.excerpt.prefix(300))
                    attr.textContent = String(a.plainLower.prefix(10_000))  // 全文検索用
                    attr.keywords = a.categories + a.tags
                    if let d = a.date { attr.contentCreationDate = d }
                    let item = CSSearchableItem(uniqueIdentifier: stableID(for: a),
                                                domainIdentifier: domain,
                                                attributeSet: attr)
                    item.expirationDate = Date.distantFuture  // 既定の約1ヶ月で失効させない
                    return item
                }
            // 200件ずつ順に投入
            var start = 0
            func next() {
                guard start < items.count else { return }
                let end = min(start + 200, items.count)
                let chunk = Array(items[start..<end])
                start = end
                index.indexSearchableItems(chunk) { _ in next() }
            }
            next()
        }
    }

    static func clear() {
        CSSearchableIndex.default()
            .deleteSearchableItems(withDomainIdentifiers: [domain], completionHandler: nil)
    }
}
