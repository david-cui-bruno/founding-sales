import Foundation
import CallieAppleCore

public enum PhoneAccessibilityError: Error, Equatable, Sendable {
    case unsupportedPhoneUIVersion
    case controlNotFound
    case controlAmbiguous
    case controlDisabled
}

public struct PhoneAccessibilityClient<Snapshotter: AXSnapshotting, Actuator: AXActuating>: Sendable {
    private let snapshotter: Snapshotter
    private let actuator: Actuator

    public init(snapshotter: Snapshotter, actuator: Actuator) {
        self.snapshotter = snapshotter
        self.actuator = actuator
    }

    public func startAndVerifyRecording() throws -> RecordingVerification {
        let before = try snapshotter.snapshot()
        try PhoneAXRules.requireSupported(before)
        let controls = before.allNodes.filter(PhoneAXRules.isRecordingControl)
        guard !controls.isEmpty else {
            throw PhoneAccessibilityError.controlNotFound
        }
        guard controls.count == 1 else {
            throw PhoneAccessibilityError.controlAmbiguous
        }
        guard controls[0].enabled else {
            throw PhoneAccessibilityError.controlDisabled
        }

        try actuator.press(nodeID: controls[0].nodeID)

        let after = try snapshotter.snapshot()
        guard PhoneAXRules.isSupported(after) else {
            return .failed(.verificationFailed)
        }
        let indicators = after.allNodes.filter(PhoneAXRules.isActiveRecordingIndicator)
        return indicators.count == 1 ? .verified : .failed(.verificationFailed)
    }
}

enum PhoneAXRules {
    static func isSupported(_ snapshot: AXNodeSnapshot) -> Bool {
        snapshot.formatVersion == 1 && snapshot.phoneUIVersion == "macos-26.4" && snapshot.application == "Phone"
    }

    static func requireSupported(_ snapshot: AXNodeSnapshot) throws {
        guard isSupported(snapshot) else {
            throw PhoneAccessibilityError.unsupportedPhoneUIVersion
        }
    }

    static func isRecordingControl(_ node: AXNode) -> Bool {
        node.role == "AXButton"
            && node.title == "Record Call"
            && node.identifier == "phone.call.record"
    }

    static func isActiveRecordingIndicator(_ node: AXNode) -> Bool {
        node.role == "AXStaticText"
            && node.title == "Recording"
            && node.identifier == "phone.call.recording-active"
            && node.enabled
            && node.value == "active"
    }
}
