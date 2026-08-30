import CallieAppleProtocol

public protocol BridgeEventEmitting: Sendable {
    @discardableResult
    func emit(_ event: BridgeEvent) -> Bool
}

public struct DiscardingBridgeEventEmitter: BridgeEventEmitting, Sendable {
    public init() {}
    public func emit(_ event: BridgeEvent) -> Bool { false }
}
