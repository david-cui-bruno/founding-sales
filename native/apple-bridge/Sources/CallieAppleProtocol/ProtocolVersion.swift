import Foundation

public enum AppleBridgeProtocol {
    public static let version = 1
    public static let maximumFrameBytes = 262_144
}

public enum AppleBridgeBuildInfo {
    /// The semantic helper version returned by `bridge.hello`.
    /// Task 9 must generate or verify the nested helper bundle's
    /// CFBundleShortVersionString from this canonical value.
    public static let helperVersion = "1.0.0"
}

public enum BridgeFrameConstructionError: Error, Sendable {
    case invalidParameters
    case mismatchedRequestParameters
    case negativeEventSequence
}
