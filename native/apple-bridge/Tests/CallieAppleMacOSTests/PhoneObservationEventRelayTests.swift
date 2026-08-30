import Foundation
import Testing
@testable import CallieAppleCore
@testable import CallieAppleMacOS
import CallieAppleProtocol

@Suite("PhoneObservationEventRelayTests")
struct PhoneObservationEventRelayTests {
    @Test func committedStartFlushesExactSanitizedFramesWithOneMonotonicSequence() throws {
        let emitter = CapturingBridgeEventEmitter()
        let relay = PhoneObservationEventRelay(emitter: emitter)
        let privateHandle = NormalizedHandle("founder.private@example.invalid")

        relay.beginObservationStart()
        relay.receive(ObservedCall(id: UUID(), outgoing: true, connected: true, ended: false, onHold: true))
        relay.receive(PhoneIdentityEvent(callID: UUID(), identity: .resolved(privateHandle)))
        relay.receive(.degraded(.phoneUIUnavailable))
        #expect(emitter.events.isEmpty)

        #expect(relay.commitObservationStart())

        #expect(emitter.events.count == 3)
        assertEvent(emitter.events[0], seq: 0, name: .callStateChanged, payload: [
            "outgoing": .bool(true),
            "connected": .bool(true),
            "ended": .bool(false),
            "onHold": .bool(true),
        ])
        assertEvent(emitter.events[1], seq: 1, name: .callIdentityResolved, payload: [
            "identity": .string("resolved"),
        ])
        assertEvent(emitter.events[2], seq: 2, name: .capabilityChanged, payload: [
            "source": .string("phone_observation"),
            "available": .bool(false),
            "reason": .string("phoneUIUnavailable"),
        ])
        #expect(!String(describing: emitter.events).contains(privateHandle.value))
    }

    @Test func capabilityReasonsMapToExactFixedVocabulary() {
        let cases: [(PhoneCallObservationDegradation, String)] = [
            (.accessibilityDenied, "accessibilityDenied"),
            (.phoneUIUnavailable, "phoneUIUnavailable"),
            (.unsupportedPhoneUIVersion, "unsupportedPhoneUIVersion"),
            (.ambiguousPhoneState, "ambiguousPhoneState"),
            (.noMacVisibleCall, "noMacVisibleCall"),
            (.snapshotFailed, "snapshotFailed"),
            (.traversalDepthExceeded, "traversalDepthExceeded"),
            (.traversalNodeLimitExceeded, "traversalNodeLimitExceeded"),
            (.traversalCycleDetected, "traversalCycleDetected"),
            (.traversalDeadlineExceeded, "traversalDeadlineExceeded"),
        ]
        let emitter = CapturingBridgeEventEmitter()
        let relay = PhoneObservationEventRelay(emitter: emitter)
        relay.beginObservationStart()
        #expect(relay.commitObservationStart())

        relay.receive(.available)
        for (reason, _) in cases { relay.receive(.degraded(reason)) }

        #expect(emitter.events.count == 11)
        assertEvent(emitter.events[0], seq: 0, name: .capabilityChanged, payload: [
            "source": .string("phone_observation"),
            "available": .bool(true),
        ])
        for (offset, entry) in cases.enumerated() {
            assertEvent(emitter.events[offset + 1], seq: offset + 1, name: .capabilityChanged, payload: [
                "source": .string("phone_observation"),
                "available": .bool(false),
                "reason": .string(entry.1),
            ])
        }
    }

    @Test func unresolvedAndAmbiguousIdentityNeverExposeHandleOrCallID() {
        let emitter = CapturingBridgeEventEmitter()
        let relay = PhoneObservationEventRelay(emitter: emitter)
        relay.beginObservationStart()
        #expect(relay.commitObservationStart())

        relay.receive(PhoneIdentityEvent(callID: UUID(), identity: .unresolved))
        relay.receive(PhoneIdentityEvent(callID: UUID(), identity: .ambiguous))

        #expect(emitter.events.count == 2)
        assertEvent(emitter.events[0], seq: 0, name: .callIdentityUnresolved, payload: [
            "identity": .string("unresolved"),
        ])
        assertEvent(emitter.events[1], seq: 1, name: .callIdentityUnresolved, payload: [
            "identity": .string("ambiguous"),
        ])
    }

    @Test func failedStartDiscardsAllBufferedEvidenceAndNextSuccessfulStartBeginsAtZero() {
        let emitter = CapturingBridgeEventEmitter()
        let relay = PhoneObservationEventRelay(emitter: emitter)

        relay.beginObservationStart()
        relay.receive(.available)
        relay.receive(ObservedCall(id: UUID(), outgoing: false, connected: true, ended: false, onHold: false))
        relay.cancelObservationStart()
        relay.receive(.degraded(.snapshotFailed))
        #expect(emitter.events.isEmpty)

        relay.beginObservationStart()
        relay.receive(PhoneIdentityEvent(callID: UUID(), identity: .unresolved))
        #expect(relay.commitObservationStart())

        #expect(emitter.events.count == 1)
        #expect(emitter.events[0].seq == 0)
        #expect(emitter.events[0].event == .callIdentityUnresolved)
    }

    @Test func startBufferExhaustionFailsClosedAndEmitsNoPartialEvidence() {
        let emitter = CapturingBridgeEventEmitter()
        let relay = PhoneObservationEventRelay(emitter: emitter)

        relay.beginObservationStart()
        for _ in 0 ... 128 { relay.receive(.available) }

        #expect(!relay.commitObservationStart())
        #expect(emitter.events.isEmpty)
        relay.receive(.degraded(.snapshotFailed))
        #expect(emitter.events.isEmpty)
    }

    @Test func deactivateSuppressesEvenSyntheticLateCallbacks() {
        let emitter = CapturingBridgeEventEmitter()
        let relay = PhoneObservationEventRelay(emitter: emitter)
        relay.beginObservationStart()
        #expect(relay.commitObservationStart())
        relay.receive(.available)

        relay.deactivate()
        relay.receive(.degraded(.snapshotFailed))
        relay.receive(ObservedCall(id: UUID(), outgoing: true, connected: false, ended: true, onHold: false))
        relay.receive(PhoneIdentityEvent(callID: UUID(), identity: .ambiguous))

        #expect(emitter.events.count == 1)
        #expect(emitter.events[0].seq == 0)

        relay.beginObservationStart()
        #expect(relay.commitObservationStart())
        relay.receive(PhoneIdentityEvent(callID: UUID(), identity: .unresolved))
        #expect(emitter.events.count == 2)
        #expect(emitter.events[1].seq == 1)
    }
}

private func assertEvent(
    _ event: BridgeEvent,
    seq: Int,
    name: BridgeEventName,
    payload: [String: JSONValue]
) {
    #expect(event.v == 1)
    #expect(event.seq == seq)
    #expect(event.event == name)
    #expect(event.payload == payload)
}

private final class CapturingBridgeEventEmitter: BridgeEventEmitting, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [BridgeEvent] = []
    var events: [BridgeEvent] { lock.withLock { storage } }

    func emit(_ event: BridgeEvent) -> Bool {
        lock.withLock { storage.append(event) }
        return true
    }
}
