// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "WXRReader",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "WXRReader",
            path: "Sources/WXRReader"
        )
    ]
)
