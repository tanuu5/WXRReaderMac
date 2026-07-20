import SwiftUI

struct LandingView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Text("📚").font(.system(size: 56)).opacity(0.7)
                .padding(.bottom, 12)
            Text("書庫")
                .font(Theme.serif(44, bold: true))
                .kerning(4)
                .foregroundColor(Theme.text)
            Text("WXR Blog Archive Reader")
                .font(.system(size: 14))
                .foregroundColor(Theme.text3)
                .padding(.top, 4)
                .padding(.bottom, 32)
            Text("noteのWXRバックアップ（.xml）を閲覧・検索・統計分析・Markdown変換できるツールです。\n処理はすべてこのMacの中で完結します。")
                .font(.system(size: 13))
                .foregroundColor(Theme.text2)
                .multilineTextAlignment(.center)
                .lineSpacing(6)
                .padding(.bottom, 32)

            if state.lastFolderPath != nil {
                restoreCard
            } else {
                openButton
            }

            Spacer()
            footer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var openButton: some View {
        VStack(spacing: 10) {
            Button {
                state.openFolderPanel()
            } label: {
                Text("📂 フォルダを選択")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(.white)
                    .padding(.horizontal, 36).padding(.vertical, 13)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.accent))
            }
            .buttonStyle(.plain)
            Text("バックアップフォルダを一度選ぶと、次回から再接続できます")
                .font(.system(size: 12))
                .foregroundColor(Theme.text3)
            Text("対応形式：WXR（WordPress eXtended RSS）。noteのエクスポートXMLに対応。")
                .font(.system(size: 11))
                .foregroundColor(Theme.text3)
                .padding(.top, 20)
        }
    }

    private var restoreCard: some View {
        VStack(spacing: 10) {
            Text("📂").font(.system(size: 36))
            Text(state.lastFolderName ?? "フォルダ")
                .font(Theme.serif(17, bold: true))
                .foregroundColor(Theme.text)
            Text("前回のフォルダ")
                .font(.system(size: 11))
                .foregroundColor(Theme.text3)
            Button {
                state.restoreLastFolder()
            } label: {
                Text("このフォルダを開く")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.accent))
            }
            .buttonStyle(.plain)
            Button {
                state.forgetFolder()
                state.openFolderPanel()
            } label: {
                Text("別のフォルダに変更…")
                    .font(.system(size: 12))
                    .foregroundColor(Theme.text3)
                    .underline()
            }
            .buttonStyle(.plain)
        }
        .padding(28)
        .frame(width: 360)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Theme.surface)
                .shadow(color: Theme.accent.opacity(0.12), radius: 10, y: 4)
        )
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.accent, lineWidth: 2))
    }

    private var footer: some View {
        VStack(spacing: 2) {
            Text("© \(String(Calendar.current.component(.year, from: Date()))) たぬ — Built with Claude (Anthropic)")
            Text("macOSネイティブ版 · SwiftUI")
                .opacity(0.7)
        }
        .font(.system(size: 11))
        .foregroundColor(Theme.text3)
        .padding(.vertical, 24)
    }
}
