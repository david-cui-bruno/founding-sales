import Foundation

enum AppleBridgeLaunchArgumentError: Error, Sendable, Equatable {
    case missingStagingRoot
    case duplicateStagingRoot
    case unknownArgument
    case missingStagingRootValue
    case extraPositional
    case invalidStagingRoot
}

struct AppleBridgeLaunchArguments: Sendable, Equatable {
    let stagingRoot: URL
}

enum AppleBridgeLaunchArgumentParser {
    private static let stagingRootFlag = "--staging-root"

    static func parse(_ arguments: [String]) throws -> AppleBridgeLaunchArguments {
        let flagCount = arguments.count { $0 == stagingRootFlag }
        if flagCount > 1 { throw AppleBridgeLaunchArgumentError.duplicateStagingRoot }
        guard flagCount == 1 else {
            guard let first = arguments.first else {
                throw AppleBridgeLaunchArgumentError.missingStagingRoot
            }
            throw first.hasPrefix("-")
                ? AppleBridgeLaunchArgumentError.unknownArgument
                : AppleBridgeLaunchArgumentError.extraPositional
        }
        guard arguments.first == stagingRootFlag else {
            throw arguments.first?.hasPrefix("-") == true
                ? AppleBridgeLaunchArgumentError.unknownArgument
                : AppleBridgeLaunchArgumentError.extraPositional
        }
        guard arguments.count > 1, !arguments[1].hasPrefix("--") else {
            throw AppleBridgeLaunchArgumentError.missingStagingRootValue
        }
        guard arguments.count == 2 else {
            throw arguments.dropFirst(2).contains(where: { $0.hasPrefix("-") })
                ? AppleBridgeLaunchArgumentError.unknownArgument
                : AppleBridgeLaunchArgumentError.extraPositional
        }

        let path = arguments[1]
        guard !path.isEmpty,
              !path.contains("\0"),
              (path as NSString).isAbsolutePath,
              path != "/",
              isLexicallyStandardAbsolutePath(path) else {
            throw AppleBridgeLaunchArgumentError.invalidStagingRoot
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
        guard url.isFileURL, url.path == path else {
            throw AppleBridgeLaunchArgumentError.invalidStagingRoot
        }
        return AppleBridgeLaunchArguments(stagingRoot: url)
    }

    private static func isLexicallyStandardAbsolutePath(_ path: String) -> Bool {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard components.first?.isEmpty == true else { return false }
        return components.dropFirst().allSatisfy {
            !$0.isEmpty && $0 != "." && $0 != ".."
        }
    }
}

enum AppleBridgeBootstrap {
    static let initializationFailureDiagnostic = Data("callie-apple-bridge: initialization failed\n".utf8)

    static func compose<Value>(
        arguments: [String],
        makeDependencies: (URL) throws -> Value
    ) throws -> Value {
        let parsed = try AppleBridgeLaunchArgumentParser.parse(arguments)
        return try makeDependencies(parsed.stagingRoot)
    }
}
