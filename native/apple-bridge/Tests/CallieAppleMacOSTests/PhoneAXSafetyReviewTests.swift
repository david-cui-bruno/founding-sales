import Foundation
import Testing
@testable import CallieAppleCore
@testable import CallieAppleMacOS

@Suite("PhoneAXSafetyReviewTests")
struct PhoneAXSafetyReviewTests {
    @Test func unchangedLiveSessionPressesOnceAndStillRequiresIndependentVerification() throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let active = try FixtureSupport.snapshot(named: "phone-recording-active")
        let actuator = CaptureCheckingActuator(
            currentToken: available.captureToken,
            liveCallProof: unchangedLiveCallProof
        )
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available, active]), actuator: actuator)

        #expect(try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true }) == .verified)
        #expect(actuator.performedNodeIDs == ["record-button"])
    }

    @Test func staleCaptureTokenFailsWithoutPerformingLiveActuation() throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let active = try FixtureSupport.snapshot(named: "phone-recording-active")
        let actuator = CaptureCheckingActuator(currentToken: UUID(uuidString: "ffffffff-ffff-4fff-8fff-ffffffffffff")!)
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available, active]), actuator: actuator)

        #expect(throws: AXSnapshotError.staleCapture) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.performedNodeIDs.isEmpty)
    }

    @Test func changedLiveElementAttributesFailWithoutPerformingLiveActuation() throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let active = try FixtureSupport.snapshot(named: "phone-recording-active")
        let actuator = CaptureCheckingActuator(currentToken: available.captureToken, liveElementMatches: false)
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available, active]), actuator: actuator)

        #expect(throws: AXSnapshotError.liveElementMismatch) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.performedNodeIDs.isEmpty)
    }

    @Test func registryRevocationBetweenLiveReadAndActionFailsWithoutPressing() throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let authorization = RevocableAuthorization()
        let actuator = CaptureCheckingActuator(
            currentToken: available.captureToken,
            liveCallProof: unchangedLiveCallProof,
            afterLiveCallRead: authorization.revoke
        )
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available]), actuator: actuator)

        #expect(throws: PhoneAccessibilityError.callAuthorizationChanged) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: authorization.isCurrent)
        }
        #expect(actuator.performedNodeIDs.isEmpty)
    }

    @Test func sameWindowSameDirectionSessionReplacementAfterCaptureFailsWithoutPressing() throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let actuator = CaptureCheckingActuator(
            currentToken: available.captureToken,
            liveCallProof: AXLiveCallProof(
                phoneUIFingerprint: "macos-26.4-phone-v1",
                recognizedCallWindowCount: 1,
                sessionFingerprint: "session-b-0001",
                outgoing: true,
                connected: true,
                onHold: false
            )
        )
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available]), actuator: actuator)

        #expect(throws: AXSnapshotError.liveCallSessionMismatch) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.performedNodeIDs.isEmpty)
    }

    @Test func liveHeldTransitionAfterCaptureFailsWithoutPressing() throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let actuator = CaptureCheckingActuator(
            currentToken: available.captureToken,
            liveCallProof: AXLiveCallProof(
                phoneUIFingerprint: "macos-26.4-phone-v1",
                recognizedCallWindowCount: 1,
                sessionFingerprint: "session-a-0001",
                outgoing: true,
                connected: true,
                onHold: true
            )
        )
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available]), actuator: actuator)

        #expect(throws: AXSnapshotError.liveCallStateMismatch) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.performedNodeIDs.isEmpty)
    }

    @Test func liveDisconnectedTransitionAfterCaptureFailsWithoutPressing() throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let actuator = CaptureCheckingActuator(
            currentToken: available.captureToken,
            liveCallProof: AXLiveCallProof(
                phoneUIFingerprint: "macos-26.4-phone-v1",
                recognizedCallWindowCount: 1,
                sessionFingerprint: "session-a-0001",
                outgoing: true,
                connected: false,
                onHold: false
            )
        )
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available]), actuator: actuator)

        #expect(throws: AXSnapshotError.liveCallStateMismatch) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.performedNodeIDs.isEmpty)
    }

    @Test func liveDirectionChangeAfterCaptureFailsWithoutPressing() throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let actuator = CaptureCheckingActuator(
            currentToken: available.captureToken,
            liveCallProof: AXLiveCallProof(
                phoneUIFingerprint: "macos-26.4-phone-v1",
                recognizedCallWindowCount: 1,
                sessionFingerprint: "session-a-0001",
                outgoing: false,
                connected: true,
                onHold: false
            )
        )
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available]), actuator: actuator)

        #expect(throws: AXSnapshotError.liveCallStateMismatch) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.performedNodeIDs.isEmpty)
    }

    @Test func missingLiveSessionFingerprintFailsWithoutPressing() throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let actuator = CaptureCheckingActuator(
            currentToken: available.captureToken,
            liveCallProof: AXLiveCallProof(
                phoneUIFingerprint: "macos-26.4-phone-v1",
                recognizedCallWindowCount: 1,
                sessionFingerprint: nil,
                outgoing: true,
                connected: true,
                onHold: false
            )
        )
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available]), actuator: actuator)

        #expect(throws: AXSnapshotError.liveCallStateUnavailable) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.performedNodeIDs.isEmpty)
    }

    @Test func ambiguousLiveCallWindowFingerprintFailsWithoutPressing() throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let actuator = CaptureCheckingActuator(
            currentToken: available.captureToken,
            liveCallProof: AXLiveCallProof(
                phoneUIFingerprint: "macos-26.4-phone-v1",
                recognizedCallWindowCount: 2,
                sessionFingerprint: "session-a-0001",
                outgoing: true,
                connected: true,
                onHold: false
            )
        )
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available]), actuator: actuator)

        #expect(throws: AXSnapshotError.liveCallStateUnavailable) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.performedNodeIDs.isEmpty)
    }

    @Test func wrongPhoneBundlePathExecutableAndUIFingerprintFailClosed() throws {
        let base = try FixtureSupport.snapshot(named: "phone-recording-available")
        let actuator = CaptureCheckingActuator(currentToken: base.captureToken)
        let wrongSnapshots = [
            base.replacing(provenance: .fixture(bundleIdentifier: "com.example.not-phone")),
            base.replacing(provenance: .fixture(applicationURL: "/Applications/Phone.app")),
            base.replacing(provenance: .fixture(executableURL: "/tmp/Phone")),
            base.replacing(phoneUIFingerprint: "unsupported-phone-ui"),
        ]

        for snapshot in wrongSnapshots {
            let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([snapshot]), actuator: actuator)
            #expect(throws: PhoneAccessibilityError.unsupportedPhoneUIVersion) {
                try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
            }
        }
        #expect(actuator.performedNodeIDs.isEmpty)
    }

    @Test func matchingRecordControlOutsideRecognizedCallWindowIsIgnored() throws {
        let outside = try FixtureSupport.snapshot(named: "phone-recording-control-outside-window")
        let actuator = CaptureCheckingActuator(currentToken: outside.captureToken)
        let client = PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([outside]), actuator: actuator)

        #expect(throws: PhoneAccessibilityError.controlNotFound) {
            try client.startAndVerifyRecording(authorization: fixtureAuthorization, isAuthorizationCurrent: { true })
        }
        #expect(actuator.performedNodeIDs.isEmpty)
    }

    @Test func verifiedProcessLocatorRejectsWrongBundleAndPaths() {
        for candidate in [
            PhoneProcessCandidate(identity: .fixture(bundleIdentifier: "com.example.not-phone"), phoneUIFingerprint: PhoneAXContract.supportedUIFingerprint),
            PhoneProcessCandidate(identity: .fixture(applicationURL: "/Applications/Phone.app"), phoneUIFingerprint: PhoneAXContract.supportedUIFingerprint),
            PhoneProcessCandidate(identity: .fixture(executableURL: "/tmp/Phone"), phoneUIFingerprint: PhoneAXContract.supportedUIFingerprint),
        ] {
            let locator = VerifiedPhoneProcessLocator(source: FixedPhoneProcessSource([candidate]))
            #expect(throws: AXSnapshotError.phoneApplicationUnavailable) {
                try locator.locatePhoneProcess()
            }
        }
        let wrongVersion = VerifiedPhoneProcessLocator(source: FixedPhoneProcessSource([
            PhoneProcessCandidate(identity: .fixture(), phoneUIFingerprint: "macos-26.5-phone-v1"),
        ]))
        #expect(throws: AXSnapshotError.unsupportedPhoneUIVersion) {
            try wrongVersion.locatePhoneProcess()
        }
    }

    @Test func controllerRejectsUnsafeCallAndRegistryMismatchBeforePress() async throws {
        let available = try FixtureSupport.snapshot(named: "phone-recording-available")
        let actuator = CaptureCheckingActuator(currentToken: available.captureToken)
        let registry = LockedCurrentPhoneCallRegistry()
        registry.replace(fixtureAuthorization)
        let controller = PhoneRecordingController(
            client: PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([available]), actuator: actuator),
            registry: registry
        )
        let ended = ObservedCall(id: fixtureCall.id, outgoing: true, connected: true, ended: true, onHold: false)
        let held = ObservedCall(id: fixtureCall.id, outgoing: true, connected: true, ended: false, onHold: true)
        let disconnected = ObservedCall(id: fixtureCall.id, outgoing: true, connected: false, ended: false, onHold: false)

        #expect(try await controller.attemptStart(for: ended) == .failed(.callEnded))
        #expect(try await controller.attemptStart(for: held) == .failed(.controllerError))
        #expect(try await controller.attemptStart(for: disconnected) == .failed(.controllerError))
        registry.clear(observationGeneration: fixtureAuthorization.observationGeneration)
        #expect(try await controller.attemptStart(for: fixtureCall) == .failed(.controllerError))
        #expect(actuator.performedNodeIDs.isEmpty)
    }

    @Test func controllerRejectsDirectionOrSessionMismatchBeforePress() async throws {
        let incoming = try FixtureSupport.snapshot(named: "phone-recording-available-incoming")
        let replacement = try FixtureSupport.snapshot(named: "phone-recording-available-replacement")
        let registry = LockedCurrentPhoneCallRegistry()
        registry.replace(fixtureAuthorization)

        for snapshot in [incoming, replacement] {
            let actuator = CaptureCheckingActuator(currentToken: snapshot.captureToken)
            let controller = PhoneRecordingController(
                client: PhoneAccessibilityClient(snapshotter: SequenceSnapshotter([snapshot]), actuator: actuator),
                registry: registry
            )
            #expect(try await controller.attemptStart(for: fixtureCall) == .failed(.controlNotFound))
            #expect(actuator.performedNodeIDs.isEmpty)
        }
    }
}

private final class CaptureCheckingActuator: AXActuating, @unchecked Sendable {
    private let lock = NSLock()
    private let currentToken: UUID
    private let liveElementMatches: Bool
    private let liveCallProof: AXLiveCallProof
    private let afterLiveCallRead: @Sendable () -> Void
    private var performed: [String] = []

    init(
        currentToken: UUID,
        liveElementMatches: Bool = true,
        liveCallProof: AXLiveCallProof = unchangedLiveCallProof,
        afterLiveCallRead: @escaping @Sendable () -> Void = {}
    ) {
        self.currentToken = currentToken
        self.liveElementMatches = liveElementMatches
        self.liveCallProof = liveCallProof
        self.afterLiveCallRead = afterLiveCallRead
    }

    var performedNodeIDs: [String] { lock.withLock { performed } }

    func press(_ request: AXActuationRequest, ifAuthorized: @Sendable () -> Bool) throws {
        guard request.captureToken == currentToken else { throw AXSnapshotError.staleCapture }
        guard liveElementMatches else { throw AXSnapshotError.liveElementMismatch }
        try request.liveCall.validate(liveCallProof)
        afterLiveCallRead()
        guard ifAuthorized() else { throw PhoneAccessibilityError.callAuthorizationChanged }
        lock.withLock { performed.append(request.element.nodeID) }
    }
}

private final class RevocableAuthorization: @unchecked Sendable {
    private let lock = NSLock()
    private var current = true
    func revoke() { lock.withLock { current = false } }
    func isCurrent() -> Bool { lock.withLock { current } }
}

private struct FixedPhoneProcessSource: RunningPhoneApplicationReading {
    let values: [PhoneProcessCandidate]
    init(_ values: [PhoneProcessCandidate]) { self.values = values }
    func runningPhoneApplications() -> [PhoneProcessCandidate] { values }
}

private extension PhoneProcessIdentity {
    static func fixture(
        bundleIdentifier: String = "com.apple.mobilephone",
        applicationURL: String = "/System/Applications/Phone.app",
        executableURL: String = "/System/Applications/Phone.app/Contents/MacOS/Phone"
    ) -> PhoneProcessIdentity {
        PhoneProcessIdentity(
            processIdentifier: 4242,
            bundleIdentifier: bundleIdentifier,
            applicationURL: applicationURL,
            executableURL: executableURL
        )
    }
}

private extension AXNodeSnapshot {
    func replacing(
        provenance: PhoneProcessIdentity? = nil,
        phoneUIFingerprint: String? = nil
    ) -> AXNodeSnapshot {
        AXNodeSnapshot(
            formatVersion: formatVersion,
            phoneUIFingerprint: phoneUIFingerprint ?? self.phoneUIFingerprint,
            captureToken: captureToken,
            provenance: provenance ?? self.provenance,
            root: root
        )
    }
}

let fixtureCall = ObservedCall(id: UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!, outgoing: true, connected: true, ended: false, onHold: false)
let fixtureAuthorization = PhoneCallAuthorization(call: fixtureCall, observationGeneration: 7, sessionFingerprint: "session-a-0001")
private let unchangedLiveCallProof = AXLiveCallProof(
    phoneUIFingerprint: "macos-26.4-phone-v1",
    recognizedCallWindowCount: 1,
    sessionFingerprint: "session-a-0001",
    outgoing: true,
    connected: true,
    onHold: false
)
