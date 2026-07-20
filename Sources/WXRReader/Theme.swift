import SwiftUI

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: 1)
    }
}

/// HTML版の和紙×深緑パレットを踏襲
enum Theme {
    static let bg = Color(hex: 0xF5F0E6)
    static let surface = Color(hex: 0xFFFDF8)
    static let text = Color(hex: 0x1E1810)
    static let text2 = Color(hex: 0x5C4F3E)
    static let text3 = Color(hex: 0x988B7A)
    static let accent = Color(hex: 0x6B8F71)
    static let accentHover = Color(hex: 0x7DA882)
    static let accentBg = Color(hex: 0xEBF2EC)
    static let border = Color(hex: 0xE2D9CB)
    static let borderLight = Color(hex: 0xEDE7DC)
    static let tagPurple = Color(hex: 0x6B5CA5)
    static let tagPurpleBg = Color(hex: 0xEDE7F6)
    static let charsBar = Color(hex: 0xB89F72)

    static let hm: [Color] = [
        Color(hex: 0xEDE7DC), Color(hex: 0xC6DEC9), Color(hex: 0x94C49A),
        Color(hex: 0x6B8F71), Color(hex: 0x4A6B4F)
    ]

    static func serif(_ size: CGFloat, bold: Bool = false) -> Font {
        .custom(bold ? "HiraMinProN-W6" : "HiraMinProN-W3", size: size)
    }
}

// MARK: - 共通部品

/// タグチップの折り返しレイアウト
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        var maxX: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > maxWidth, x > 0 { x = 0; y += rowH + spacing; rowH = 0 }
            x += s.width + spacing
            maxX = max(maxX, x)
            rowH = max(rowH, s.height)
        }
        let w = maxWidth.isFinite ? maxWidth : maxX
        return CGSize(width: w, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += s.width + spacing
            rowH = max(rowH, s.height)
        }
    }
}

struct TagChip: View {
    let name: String
    var isTag = false   // true=タグ（紫）, false=カテゴリ（緑）
    var action: (() -> Void)? = nil

    var body: some View {
        let label = Text(name)
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(isTag ? Theme.tagPurple : Theme.accent)
            .padding(.horizontal, 10).padding(.vertical, 2)
            .background(Capsule().fill(isTag ? Theme.tagPurpleBg : Theme.accentBg))
        if let action {
            Button(action: action) { label }.buttonStyle(.plain)
        } else {
            label
        }
    }
}

/// 小型コントロールボタン（ctrl-btn相当）
struct CtrlButton: View {
    let title: String
    var active = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12))
                .foregroundColor(active ? Theme.accent : Theme.text2)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(active ? Theme.accentBg : Theme.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(active ? Theme.accent : Theme.border, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}
