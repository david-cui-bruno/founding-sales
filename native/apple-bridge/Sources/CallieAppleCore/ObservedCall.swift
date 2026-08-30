import Foundation

public struct ObservedCall: Sendable, Equatable {
    public let id: UUID
    public let outgoing: Bool
    public let connected: Bool
    public let ended: Bool
    public let onHold: Bool

    public init(id: UUID, outgoing: Bool, connected: Bool, ended: Bool, onHold: Bool) {
        self.id = id
        self.outgoing = outgoing
        self.connected = connected
        self.ended = ended
        self.onHold = onHold
    }
}
