import SwiftUI
import Charts

struct StatsPanel: View {
    let stats: BlogStats

    var body: some View {
        VStack(spacing: 14) {
            heatmapSection
            chartSection(title: "📊 月間投稿数", mode: .count)
            chartSection(title: "📝 月間文字数", mode: .chars)
            if !stats.cats.isEmpty || !stats.tags.isEmpty {
                rankingSection
            }
        }
    }

    private func sectionBox<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(Theme.serif(15, bold: true))
                .foregroundColor(Theme.text)
            content()
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.borderLight))
    }

    // MARK: - ヒートマップ

    private var heatmapSection: some View {
        sectionBox("🟩 投稿カレンダー") {
            HStack(spacing: 14) {
                badge("\(stats.currentStreak)", "現在の連続日数")
                badge("\(stats.longestStreak)", "最長連続日数")
                badge("\(stats.totalDays)", "投稿した日数")
            }
            HeatmapView(daily: stats.daily, sortedDays: stats.sortedDays)
            HStack(spacing: 4) {
                Text("少ない").font(.system(size: 10)).foregroundColor(Theme.text3)
                ForEach(0..<5, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 2).fill(Theme.hm[i]).frame(width: 11, height: 11)
                }
                Text("多い").font(.system(size: 10)).foregroundColor(Theme.text3)
            }
        }
    }

    private func badge(_ num: String, _ label: String) -> some View {
        VStack(spacing: 0) {
            Text(num).font(Theme.serif(20, bold: true)).foregroundColor(Theme.accent)
            Text(label).font(.system(size: 10)).foregroundColor(Theme.text3)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bg))
    }

    // MARK: - 月間チャート

    enum ChartMode { case count, chars }

    private func chartSection(title: String, mode: ChartMode) -> some View {
        sectionBox(title) {
            if stats.monthly.isEmpty {
                Text("投稿データがありません").font(.system(size: 12)).foregroundColor(Theme.text3)
            } else {
                Chart(stats.monthly) { m in
                    BarMark(
                        x: .value("月", m.key),
                        y: .value(mode == .count ? "記事数" : "文字数",
                                  mode == .count ? m.count : m.chars)
                    )
                    .foregroundStyle(mode == .count ? Theme.accent : Theme.charsBar)
                    .cornerRadius(2)
                }
                .chartXAxis {
                    AxisMarks { value in
                        AxisGridLine()
                        AxisValueLabel {
                            // ラベルは最大12個程度に間引く
                            if let s = value.as(String.self),
                               value.index % max(1, value.count / 12) == 0 {
                                Text(shortMonth(s)).font(.system(size: 9))
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks { value in
                        AxisGridLine()
                        AxisValueLabel {
                            if let v = value.as(Int.self) {
                                Text(mode == .chars && v >= 10000
                                     ? String(format: "%.1f万", Double(v) / 10000)
                                     : v.formatted())
                                .font(.system(size: 9))
                            }
                        }
                    }
                }
                .frame(height: 170)
            }
        }
    }

    private func shortMonth(_ key: String) -> String {
        // "2024-03" → "24/3"
        let parts = key.split(separator: "-")
        guard parts.count == 2 else { return key }
        return String(parts[0].suffix(2)) + "/" + String(Int(parts[1]) ?? 0)
    }

    // MARK: - カテゴリ・タグランキング

    private var rankingSection: some View {
        sectionBox("🏷️ カテゴリ・タグ") {
            HStack(alignment: .top, spacing: 24) {
                rankColumn(items: stats.cats, color: Theme.accent, label: "カテゴリ")
                rankColumn(items: stats.tags, color: Theme.tagPurple, label: "タグ")
            }
        }
    }

    private func rankColumn(items: [(name: String, count: Int)], color: Color, label: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(items.isEmpty ? label : "\(label)（\(items.count)種類）")
                .font(.system(size: 12))
                .foregroundColor(Theme.text2)
            if items.isEmpty {
                Text("なし").font(.system(size: 12)).foregroundColor(Theme.text3)
            } else {
                let top = Array(items.prefix(15))
                let maxVal = max(top[0].count, 1)
                ForEach(top.indices, id: \.self) { i in
                    let item = top[i]
                    HStack(spacing: 8) {
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 3).fill(Theme.bg)
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(color)
                                    .frame(width: geo.size.width * CGFloat(item.count) / CGFloat(maxVal))
                                Text(item.name)
                                    .font(.system(size: 11))
                                    .foregroundColor(Theme.text)
                                    .padding(.leading, 6)
                                    .lineLimit(1)
                            }
                        }
                        .frame(height: 20)
                        Text("\(item.count)")
                            .font(.system(size: 11).monospacedDigit())
                            .foregroundColor(Theme.text3)
                            .frame(width: 32, alignment: .trailing)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - GitHub風ヒートマップ

struct HeatmapView: View {
    let daily: [String: Int]
    let sortedDays: [String]

    @State private var hoverLabel: String? = nil
    @State private var hoverPoint: CGPoint = .zero

    private static let cell: CGFloat = 11
    private static let gap: CGFloat = 2
    private static let unit: CGFloat = cell + gap
    private static let leftPad: CGFloat = 26
    private static let topPad: CGFloat = 20

    /// 週ごとの日付列（先頭週の日曜から末尾週の土曜まで）
    private var weeks: [[Date]] {
        guard let firstKey = sortedDays.first, let lastKey = sortedDays.last,
              let first = Fmt.dateKey.date(from: firstKey),
              let last = Fmt.dateKey.date(from: lastKey) else { return [] }
        let cal = Calendar.current
        let startOffset = cal.component(.weekday, from: first) - 1   // 日曜=1
        let start = cal.date(byAdding: .day, value: -startOffset, to: first)!
        let endOffset = 7 - cal.component(.weekday, from: last)
        let end = cal.date(byAdding: .day, value: endOffset, to: last)!

        var out: [[Date]] = []
        var week: [Date] = []
        var cur = start
        while cur <= end {
            week.append(cur)
            if cal.component(.weekday, from: cur) == 7 { out.append(week); week = [] }
            cur = cal.date(byAdding: .day, value: 1, to: cur)!
        }
        if !week.isEmpty { out.append(week) }
        return out
    }

    var body: some View {
        if weeks.isEmpty {
            Text("投稿データがありません").font(.system(size: 12)).foregroundColor(Theme.text3)
        } else {
            let wks = weeks
            let w = Self.leftPad + CGFloat(wks.count) * Self.unit + 4
            let h = Self.topPad + 7 * Self.unit + 4
            ScrollView(.horizontal, showsIndicators: true) {
                canvas(wks: wks)
                    .frame(width: w, height: h)
                    .overlay(alignment: .topLeading) {
                        if let label = hoverLabel {
                            Text(label)
                                .font(.system(size: 11))
                                .foregroundColor(Theme.surface)
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(RoundedRectangle(cornerRadius: 4).fill(Theme.text))
                                .offset(x: max(0, hoverPoint.x - 40), y: max(0, hoverPoint.y - 30))
                                .allowsHitTesting(false)
                        }
                    }
            }
        }
    }

    private func canvas(wks: [[Date]]) -> some View {
        Canvas { ctx, _ in
            let cal = Calendar.current
            // 曜日ラベル（月・水・金）
            let dayLabels = [1: "", 2: "月", 3: "", 4: "水", 5: "", 6: "金", 7: ""]
            for dow in 1...7 {
                if let s = dayLabels[dow], !s.isEmpty {
                    let y = Self.topPad + CGFloat(dow - 1) * Self.unit + Self.cell - 2
                    ctx.draw(Text(s).font(.system(size: 9)).foregroundColor(Theme.text3),
                             at: CGPoint(x: Self.leftPad - 8, y: y), anchor: .trailing)
                }
            }
            // 月ラベル + セル
            var lastMonth = -1
            for (wi, week) in wks.enumerated() {
                if let firstDay = week.first {
                    let m = cal.component(.month, from: firstDay)
                    let d = cal.component(.day, from: firstDay)
                    if m != lastMonth && d <= 7 {
                        lastMonth = m
                        let year = cal.component(.year, from: firstDay)
                        let label = (m == 1 || wi == 0) ? "\(year)/\(m)月" : "\(m)月"
                        ctx.draw(Text(label).font(.system(size: 9)).foregroundColor(Theme.text3),
                                 at: CGPoint(x: Self.leftPad + CGFloat(wi) * Self.unit, y: 8),
                                 anchor: .leading)
                    }
                }
                for day in week {
                    let dow = cal.component(.weekday, from: day) - 1
                    let key = Fmt.dateKey.string(from: day)
                    let count = daily[key] ?? 0
                    let color: Color
                    switch count {
                    case 0: color = Theme.hm[0]
                    case 1: color = Theme.hm[1]
                    case 2: color = Theme.hm[2]
                    case 3: color = Theme.hm[3]
                    default: color = Theme.hm[4]
                    }
                    let rect = CGRect(x: Self.leftPad + CGFloat(wi) * Self.unit,
                                      y: Self.topPad + CGFloat(dow) * Self.unit,
                                      width: Self.cell, height: Self.cell)
                    ctx.fill(Path(roundedRect: rect, cornerRadius: 2), with: .color(color))
                }
            }
        }
        .onContinuousHover { phase in
            switch phase {
            case .active(let p):
                hoverPoint = p
                hoverLabel = labelAt(p, wks: weeks)
            case .ended:
                hoverLabel = nil
            }
        }
    }

    private func labelAt(_ p: CGPoint, wks: [[Date]]) -> String? {
        let wi = Int((p.x - Self.leftPad) / Self.unit)
        let dow = Int((p.y - Self.topPad) / Self.unit)
        guard wi >= 0, wi < wks.count, dow >= 0, dow < 7 else { return nil }
        let cal = Calendar.current
        guard let day = wks[wi].first(where: { cal.component(.weekday, from: $0) - 1 == dow })
        else { return nil }
        let key = Fmt.dateKey.string(from: day)
        return "\(key)：\(daily[key] ?? 0)件"
    }
}
