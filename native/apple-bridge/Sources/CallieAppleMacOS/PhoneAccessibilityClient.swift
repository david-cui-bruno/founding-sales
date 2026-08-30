import Foundation
import CallieAppleCore

public enum PhoneAccessibilityError: Error, Equatable, Sendable {
    case unsupportedPhoneUIVersion
    case callWindowNotFound
    case callWindowAmbiguous
    case callWindowDisabled
    case sessionFingerprintUnavailable
    case callStateUnavailable
    case callAuthorizationChanged
    case controlNotFound
    case controlAmbiguous
    case controlDisabled
}

struct PhoneCallWindowInspection: Equatable, Sendable {
    let window: AXNode
    let sessionFingerprint: String
    let outgoing: Bool
    let connected: Bool
    let onHold: Bool
    let identity: PhoneIdentitySnapshot
}

public struct PhoneAccessibilityClient<Snapshotter: AXSnapshotting, Actuator: AXActuating>: Sendable {
    private let snapshotter: Snapshotter
    private let actuator: Actuator

    public init(snapshotter: Snapshotter, actuator: Actuator) {
        self.snapshotter = snapshotter
        self.actuator = actuator
    }

    public func startAndVerifyRecording(
        authorization: PhoneCallAuthorization,
        isAuthorizationCurrent: @Sendable () -> Bool
    ) throws -> RecordingVerification {
        guard authorization.call.connected, !authorization.call.ended, !authorization.call.onHold else {
            throw PhoneAccessibilityError.callAuthorizationChanged
        }
        let before = try snapshotter.snapshot()
        let callWindow = try PhoneAXRules.requireActiveCallWindow(in: before)
        guard
            callWindow.connected,
            !callWindow.onHold,
            callWindow.outgoing == authorization.call.outgoing,
            callWindow.sessionFingerprint == authorization.sessionFingerprint,
            isAuthorizationCurrent()
        else { throw PhoneAccessibilityError.callAuthorizationChanged }

        let controls = callWindow.window.flattened.filter(PhoneAXRules.isRecordingControl)
        guard !controls.isEmpty else { throw PhoneAccessibilityError.controlNotFound }
        guard controls.count == 1 else { throw PhoneAccessibilityError.controlAmbiguous }
        guard controls[0].enabled else { throw PhoneAccessibilityError.controlDisabled }

        try actuator.press(AXActuationRequest(
            captureToken: before.captureToken,
            provenance: before.provenance,
            phoneUIFingerprint: before.phoneUIFingerprint,
            callWindow: AXElementExpectation(node: callWindow.window),
            element: AXElementExpectation(node: controls[0])
        ), ifAuthorized: isAuthorizationCurrent)

        let after = try snapshotter.snapshot()
        guard
            let verifiedWindow = try? PhoneAXRules.requireActiveCallWindow(in: after),
            verifiedWindow.connected,
            !verifiedWindow.onHold,
            verifiedWindow.outgoing == authorization.call.outgoing,
            verifiedWindow.sessionFingerprint == authorization.sessionFingerprint,
            isAuthorizationCurrent()
        else { return .failed(.verificationFailed) }
        let indicators = verifiedWindow.window.flattened.filter(PhoneAXRules.isActiveRecordingIndicator)
        return indicators.count == 1 ? .verified : .failed(.verificationFailed)
    }
}

enum PhoneAXRules {
    static func requireSupported(_ snapshot: AXNodeSnapshot) throws {
        guard
            snapshot.formatVersion == 1,
            snapshot.phoneUIFingerprint == PhoneAXContract.supportedUIFingerprint,
            snapshot.provenance.isAuthoritativePhone,
            snapshot.root.role == "AXApplication"
        else { throw PhoneAccessibilityError.unsupportedPhoneUIVersion }
    }

    static func activeCallWindow(in snapshot: AXNodeSnapshot) throws -> PhoneCallWindowInspection? {
        try requireSupported(snapshot)
        let matchingWindows = snapshot.root.children.filter(isRecognizedCallWindow)
        guard !matchingWindows.isEmpty else { return nil }
        guard matchingWindows.count == 1 else { throw PhoneAccessibilityError.callWindowAmbiguous }
        let window = matchingWindows[0]
        guard window.enabled else { throw PhoneAccessibilityError.callWindowDisabled }
        guard let sessionFingerprint = window.value, isValidSessionFingerprint(sessionFingerprint) else {
            throw PhoneAccessibilityError.sessionFingerprintUnavailable
        }
        let nodes = window.flattened
        let states = nodes.filter { $0.identifier == "phone.call.state" }
        let directions = nodes.filter { $0.identifier == "phone.call.direction" }
        guard states.count == 1, directions.count == 1, let state = states[0].value, let direction = directions[0].value else {
            throw PhoneAccessibilityError.callStateUnavailable
        }
        let outgoing: Bool
        switch direction {
        case "outgoing": outgoing = true
        case "incoming": outgoing = false
        default: throw PhoneAccessibilityError.callStateUnavailable
        }
        let connected: Bool
        let onHold: Bool
        switch state {
        case "connecting": connected = false; onHold = false
        case "connected": connected = true; onHold = false
        case "held": connected = true; onHold = true
        default: throw PhoneAccessibilityError.callStateUnavailable
        }
        return PhoneCallWindowInspection(
            window: window,
            sessionFingerprint: sessionFingerprint,
            outgoing: outgoing,
            connected: connected,
            onHold: onHold,
            identity: parseIdentity(in: nodes, outgoing: outgoing)
        )
    }

    static func requireActiveCallWindow(in snapshot: AXNodeSnapshot) throws -> PhoneCallWindowInspection {
        guard let inspection = try activeCallWindow(in: snapshot) else {
            throw PhoneAccessibilityError.callWindowNotFound
        }
        return inspection
    }

    static func isRecognizedCallWindow(_ node: AXNode) -> Bool {
        node.role == "AXWindow" && node.title == "Call" && node.identifier == "phone.call.window"
    }

    static func isRecordingControl(_ node: AXNode) -> Bool {
        node.role == "AXButton" && node.title == "Record Call" && node.identifier == "phone.call.record"
    }

    static func isActiveRecordingIndicator(_ node: AXNode) -> Bool {
        node.role == "AXStaticText"
            && node.title == "Recording"
            && node.identifier == "phone.call.recording-active"
            && node.enabled
            && node.value == "active"
    }

    private static func parseIdentity(in nodes: [AXNode], outgoing: Bool) -> PhoneIdentitySnapshot {
        // Outgoing identity is armed separately by Callie; Phone labels never override it.
        guard !outgoing else { return .unresolved }
        let identityNodes = nodes.filter { $0.identifier == "phone.call.identity" }
        guard identityNodes.count <= 1 else { return .ambiguous }
        guard let raw = identityNodes.first?.value else { return .unresolved }
        if isE164Like(raw) || isValidEmail(raw) {
            return .resolved(NormalizedHandle(raw))
        }
        return .unresolved
    }

    private static func isValidSessionFingerprint(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9_-]{8,64}$"#, options: .regularExpression) != nil
    }

    private static func isE164Like(_ value: String) -> Bool {
        value.range(of: #"^\+[1-9][0-9]{7,14}$"#, options: .regularExpression) != nil
    }

    private static func isValidEmail(_ value: String) -> Bool {
        guard value.count <= 254, !value.contains(" ") else { return false }
        return value.range(
            of: #"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$"#,
            options: .regularExpression
        ) != nil
    }
}
