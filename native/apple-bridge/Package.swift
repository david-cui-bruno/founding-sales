// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CallieAppleBridge",
    platforms: [.macOS("26.4")],
    products: [
        .library(name: "CallieAppleProtocol", targets: ["CallieAppleProtocol"]),
        .library(name: "CallieAppleCore", targets: ["CallieAppleCore"]),
        .library(name: "CallieAppleMacOS", targets: ["CallieAppleMacOS"]),
        .executable(name: "CallieAppleBridge", targets: ["CallieAppleBridge"]),
    ],
    targets: [
        .target(name: "CallieAppleProtocol"),
        .target(name: "CallieAppleCore", dependencies: ["CallieAppleProtocol"]),
        .target(name: "CallieAppleMacOS", dependencies: ["CallieAppleCore"]),
        .executableTarget(name: "CallieAppleBridge", dependencies: ["CallieAppleCore", "CallieAppleProtocol"]),
        .testTarget(name: "CallieAppleProtocolTests", dependencies: ["CallieAppleProtocol"]),
        .testTarget(name: "CallieAppleCoreTests", dependencies: ["CallieAppleBridge", "CallieAppleCore", "CallieAppleProtocol"]),
        .testTarget(
            name: "CallieAppleMacOSTests",
            dependencies: ["CallieAppleMacOS", "CallieAppleCore"],
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageModes: [.v6]
)
