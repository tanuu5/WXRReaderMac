import SwiftUI
import AppKit
import CoreSpotlight

@main
struct WXRReaderApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var state = AppState.shared

    var body: some Scene {
        WindowGroup("書庫") {
            ContentView()
                .environmentObject(state)
        }
        .defaultSize(width: 1080, height: 800)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// Spotlight検索結果のクリックはSwiftUIのonContinueUserActivityに届かないことがあるため、
    /// AppKitのdelegate経由で確実に受ける（コールドローンチ・起動中の両方に対応）
    func application(_ application: NSApplication,
                     continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([NSUserActivityRestoring]) -> Void) -> Bool {
        guard userActivity.activityType == CSSearchableItemActionType,
              let id = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String
        else { return false }
        DispatchQueue.main.async {
            AppState.shared.openFromSpotlight(id)
        }
        return true
    }
}

struct ContentView: View {
    @EnvironmentObject var state: AppState
    @State private var keyMonitor: Any? = nil

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                switch state.phase {
                case .landing: LandingView()
                case .parsing: ParsingView()
                case .list:
                    if state.selected != nil {
                        DetailView()
                    } else {
                        ListView()
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg)

            if let msg = state.toastMessage {
                Text(msg)
                    .font(.system(size: 13))
                    .foregroundColor(Theme.surface)
                    .padding(.horizontal, 20).padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.text))
                    .padding(24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: state.toastMessage)
        .sheet(isPresented: $state.showHelp) { HelpView() }
        .sheet(isPresented: Binding(
            get: { state.exportProgress != nil },
            set: { _ in }
        )) { ExportProgressView() }
        .onAppear {
            guard keyMonitor == nil else { return }
            keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                state.handleKey(event) ? nil : event
            }
        }
        .onDisappear {
            if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
        }
        .onContinueUserActivity(CSSearchableItemActionType) { activity in
            if let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String {
                state.openFromSpotlight(id)
            }
        }
    }
}

struct ExportProgressView: View {
    @EnvironmentObject var state: AppState
    var body: some View {
        VStack(spacing: 16) {
            Text("📝 Markdownエクスポート")
                .font(Theme.serif(16, bold: true))
            ProgressView(value: state.exportProgress ?? 0)
                .frame(width: 280)
            Text("\(Int((state.exportProgress ?? 0) * 100))%")
                .font(.system(size: 12))
                .foregroundColor(Theme.text3)
        }
        .padding(36)
        .background(Theme.surface)
    }
}

struct HelpView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("📖 書庫の使い方")
                .font(Theme.serif(17, bold: true))
                .padding(.bottom, 16)

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    helpSection("🔍 検索", rows: [
                        ("スペース区切り", "AND検索（例: Claude API）"),
                        ("OR", "OR検索（例: Claude OR GPT）"),
                        ("タグをクリック", "そのタグで絞り込み"),
                    ], note: "本文全文が検索対象です")
                    helpSection("⌨️ キーボードショートカット", rows: [
                        ("/", "検索ボックスにフォーカス"),
                        ("j / k", "詳細ビューで次 / 前の記事へ"),
                        ("Esc", "検索をクリア、または一覧に戻る"),
                    ], note: nil)
                    helpSection("📤 エクスポート", rows: [
                        ("📝 MD一括", "絞り込み中の記事をMarkdownで一括保存"),
                        ("📋 CSV", "記事一覧をCSV（タイトル・日付・文字数など）"),
                        ("詳細の MDコピー", "本文をMarkdown形式でクリップボードにコピー"),
                    ], note: nil)
                    helpSection("🔗 関連記事", rows: [], note: "詳細ページ下部にキーワード重複度で算出した関連記事を最大6件表示します。")
                    helpSection("🖼 画像表示", rows: [], note: "バックアップ内の assets フォルダの画像をそのまま表示します。")
                }
            }
            .frame(maxHeight: 380)

            HStack {
                Spacer()
                Button("閉じる") { state.showHelp = false }
                    .keyboardShortcut(.defaultAction)
                Spacer()
            }
            .padding(.top, 16)
        }
        .padding(28)
        .frame(width: 520)
        .background(Theme.surface)
    }

    @ViewBuilder
    private func helpSection(_ title: String, rows: [(String, String)], note: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 13, weight: .bold))
                .foregroundColor(Theme.text)
            Divider()
            ForEach(rows.indices, id: \.self) { i in
                let row = rows[i]
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(row.0)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(Theme.text3)
                        .frame(width: 130, alignment: .leading)
                    Text(row.1)
                        .font(.system(size: 12))
                        .foregroundColor(Theme.text2)
                }
            }
            if let note {
                Text(note)
                    .font(.system(size: 11))
                    .foregroundColor(Theme.text3)
            }
        }
    }
}
