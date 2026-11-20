// swift-tools-version: 5.9
import PackageDescription

// Gemeinsamer Code der iPhone- und der Mac-App: Protokoll, Kamera, Aufnahme, Ablauf.
let package = Package(
    name: "SplattwinKit",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "SplattwinKit", targets: ["SplattwinKit"])],
    targets: [
        .target(name: "SplattwinKit"),
        .testTarget(name: "SplattwinKitTests", dependencies: ["SplattwinKit"]),
    ]
)
