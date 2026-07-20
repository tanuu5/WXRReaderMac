import SwiftUI

struct ListView: View {
    @EnvironmentObject var state: AppState
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.border)
            ScrollView {
                VStack(spacing: 14) {
                    summary
                    if state.showStats, let st = state.stats {
                        StatsPanel(stats: st)
                    }
                    if state.filtered.isEmpty {
                        emptyState
                    } else {
                        LazyVStack(spacing: 12) {
                            ForEach(state.filtered) { a in
                                ArticleCard(article: a)
                            }
                        }
                        Text("\(state.filtered.count)件")
                            .font(.system(size: 12))
                            .foregroundColor(Theme.text3)
                            .padding(.top, 8)
                    }
                }
                .padding(24)
                .frame(maxWidth: 960)
                .frame(maxWidth: .infinity)
            }
        }
        .onChange(of: state.searchFocusRequest) { _ in searchFocused = true }
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 10) {
            HStack(spacing: 14) {
                Text(state.channelTitle)
                    .font(Theme.serif(18, bold: true))
                    .foregroundColor(Theme.text)
                    .lineLimit(1)
                Text("\(state.postCount)記事" + (state.files.count > 1 ? " / \(state.files.count)ファイル" : ""))
                    .font(.system(size: 12))
                    .foregroundColor(Theme.text3)
                TextField("検索（スペース=AND、OR で分岐）", text: $state.query)
                    .textFieldStyle(.roundedBorder)
                    .focused($searchFocused)
                    .frame(minWidth: 220)
                Text("/")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(Theme.text3)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.border))
                    .help("スラッシュキーで検索にフォーカス")
            }
            HStack(spacing: 8) {
                CtrlButton(title: "新しい順", active: state.sortDesc) { state.sortDesc = true }
                CtrlButton(title: "古い順", active: !state.sortDesc) { state.sortDesc = false }
                Divider().frame(height: 16)
                CtrlButton(title: "記事", active: state.typeFilter == "post") { state.typeFilter = "post" }
                if state.pageCount > 0 {
                    CtrlButton(title: "固定ページ", active: state.typeFilter == "page") { state.typeFilter = "page" }
                }
                CtrlButton(title: "すべて", active: state.typeFilter == "all") { state.typeFilter = "all" }
                Divider().frame(height: 16)
                CtrlButton(title: "📊 統計", active: state.showStats) { state.showStats.toggle() }
                CtrlButton(title: "📝 MD一括") { state.batchExportMd() }
                CtrlButton(title: "📋 CSV") { state.exportCSV() }
                CtrlButton(title: "📂 フォルダ変更") {
                    state.phase = .landing
                }
                CtrlButton(title: "？") { state.showHelp = true }
                Spacer()
            }
        }
        .padding(.horizontal, 24).padding(.vertical, 14)
        .background(Theme.surface)
    }

    // MARK: - Summary

    private var summary: some View {
        HStack(spacing: 0) {
            summaryItem("記事数", "\(state.postCount)", accent: true)
            summaryItem("期間", state.dateRangeLabel)
            summaryItem("総文字数", state.totalChars.formatted())
            summaryItem("ファイル", "\(state.files.count)個 / \(String(format: "%.1f", state.totalMB)) MB")
        }
        .padding(.vertical, 18).padding(.horizontal, 8)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.borderLight))
    }

    private func summaryItem(_ label: String, _ value: String, accent: Bool = false) -> some View {
        VStack(spacing: 2) {
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundColor(Theme.text3)
                .textCase(.uppercase)
            Text(value)
                .font(Theme.serif(16, bold: true))
                .foregroundColor(accent ? Theme.accent : Theme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Text("📭").font(.system(size: 40)).opacity(0.5)
            Text(state.query.isEmpty ? "表示できる記事がありません" : "該当する記事がありません")
                .font(.system(size: 13))
                .foregroundColor(Theme.text3)
        }
        .padding(.vertical, 60)
    }
}

// MARK: - 記事カード

struct ArticleCard: View {
    @EnvironmentObject var state: AppState
    let article: Article
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(article.title.isEmpty ? "(無題)" : article.title)
                        .font(Theme.serif(15, bold: true))
                        .foregroundColor(hovering ? Theme.accent : Theme.text)
                        .lineSpacing(3)
                    Spacer()
                    Text(article.dateString)
                        .font(.system(size: 12).monospacedDigit())
                        .foregroundColor(Theme.text3)
                }
                Text(article.excerpt)
                    .font(.system(size: 12.5))
                    .foregroundColor(Theme.text2)
                    .lineSpacing(3)
                    .lineLimit(2)
                if !article.categories.isEmpty || !article.tags.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(article.categories, id: \.self) { c in
                            TagChip(name: c) { state.filterByTag(c) }
                        }
                        ForEach(article.tags, id: \.self) { t in
                            TagChip(name: t, isTag: true) { state.filterByTag(t) }
                        }
                    }
                }
                if !article.link.isEmpty {
                    HStack(spacing: 8) {
                        Text(article.link)
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundColor(Theme.text3)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Button("コピー") {
                            state.copyToClipboard(article.link, message: "URLをコピーしました")
                        }
                        .buttonStyle(.plain)
                        .font(.system(size: 10.5))
                        .foregroundColor(Theme.text3)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.border))
                    }
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { state.select(article) }

            Button {
                state.exportArticleMd(article)
            } label: {
                Text("📝")
                    .font(.system(size: 13))
                    .frame(width: 32, height: 32)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.border))
            }
            .buttonStyle(.plain)
            .help("Markdownで保存")
        }
        .padding(18)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(hovering ? Theme.accent : Theme.borderLight))
        .onHover { hovering = $0 }
    }
}
