import Foundation

public enum AppleBridgeProtocol {
    public static let version = 1
    public static let maximumFrameBytes = 262_144
}

public enum BridgeFrameConstructionError: Error, Sendable {
    case invalidParameters
    case mismatchedRequestParameters
    case negativeEventSequence
}
