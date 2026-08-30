// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CallieAppleBridge",
    platforms: [.macOS("26.4")],
    products: [
        .library(name: "CallieAppleProtocol", targets: ["CallieAppleProtocol"]),
    ],
    targets: [
        .target(name: "CallieAppleProtocol"),
        .testTarget(name: "CallieAppleProtocolTests", dependencies: ["CallieAppleProtocol"]),
    ]
)
