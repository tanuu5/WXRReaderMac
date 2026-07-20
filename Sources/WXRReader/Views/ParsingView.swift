import SwiftUI

struct ParsingView: View {
    @EnvironmentObject var state: AppState
    @State private var elapsed = "0:00"
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("解析中…")
                .font(Theme.serif(24, bold: true))
                .foregroundColor(Theme.text)
            Text(state.parseFileLabel.isEmpty
                 ? "ファイル 1 / \(max(state.files.count, 1))"
                 : state.parseFileLabel)
                .font(.system(size: 13))
                .foregroundColor(Theme.text2)
                .lineLimit(1)
                .frame(maxWidth: 480)

            VStack(spacing: 8) {
                ProgressView(value: state.parseProgress)
                    .tint(Theme.accent)
                HStack {
                    Text("\(Int(state.parseProgress * 100))%")
                    Spacer()
                    Text("\(state.files.count)ファイル / \(String(format: "%.1f", state.totalMB)) MB")
                }
                .font(.system(size: 12))
                .foregroundColor(Theme.text3)
            }
            .frame(width: 480)

            HStack(spacing: 40) {
                VStack {
                    Text("\(state.parseCount)")
                        .font(Theme.serif(24, bold: true))
                        .foregroundColor(Theme.accent)
                    Text("記事を検出")
                        .font(.system(size: 12))
                        .foregroundColor(Theme.text2)
                }
                VStack {
                    Text(elapsed)
                        .font(Theme.serif(24, bold: true))
                        .foregroundColor(Theme.accent)
                    Text("経過時間")
                        .font(.system(size: 12))
                        .foregroundColor(Theme.text2)
                }
            }
            .padding(.top, 8)

            Button {
                state.cancelParse()
            } label: {
                Text("キャンセル")
                    .font(.system(size: 13))
                    .foregroundColor(Theme.text3)
                    .underline()
            }
            .buttonStyle(.plain)
            .padding(.top, 20)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onReceive(timer) { _ in
            let s = Int(Date().timeIntervalSince(state.parseStart))
            elapsed = "\(s / 60):" + String(format: "%02d", s % 60)
        }
    }
}
