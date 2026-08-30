import Testing
@testable import CallieAppleCore
@testable import CallieAppleMacOS

@Suite("ContactsClassifierTests")
struct ContactsClassifierTests {
    @Test func rawAuthorizationStatusesMapFailClosedIncludingLimited() {
        #expect(SystemContactStore.contactAccess(forAuthorizationRawValue: 0) == .notDetermined)
        #expect(SystemContactStore.contactAccess(forAuthorizationRawValue: 1) == .restricted)
        #expect(SystemContactStore.contactAccess(forAuthorizationRawValue: 2) == .denied)
        #expect(SystemContactStore.contactAccess(forAuthorizationRawValue: 3) == .full)
        #expect(SystemContactStore.contactAccess(forAuthorizationRawValue: 4) == .limited)
        #expect(SystemContactStore.contactAccess(forAuthorizationRawValue: 99) == .denied)
    }

    @Test func limitedContactAccessReturnsUnavailableClassification() async {
        let classifier = ContactsClassifier(store: FakeContactStore(access: .limited, membership: .notFound))

        #expect(await classifier.classify(fixtureHandle) == .classificationUnavailable)
    }

    @Test func deniedRestrictedAndNotDeterminedAccessReturnUnavailableClassification() async {
        for access in [ContactAccess.denied, .restricted, .notDetermined] {
            let classifier = ContactsClassifier(store: FakeContactStore(access: access, membership: .found))
            #expect(await classifier.classify(fixtureHandle) == .classificationUnavailable)
        }
    }

    @Test func fullAccessReturnsLiteralKnownAndUnknownIdentityResolutions() async {
        let known = ContactsClassifier(store: FakeContactStore(access: .full, membership: .found))
        let unknown = ContactsClassifier(store: FakeContactStore(access: .full, membership: .notFound))

        #expect(await known.classify(fixtureHandle) == .resolved(.resolved(fixtureHandle, contactMembership: .found)))
        #expect(await unknown.classify(fixtureHandle) == .resolved(.resolved(fixtureHandle, contactMembership: .notFound)))
    }

    @Test func contactStoreFailureFailsClosed() async {
        let classifier = ContactsClassifier(store: FakeContactStore(access: .full, error: SyntheticError.failed))

        #expect(await classifier.classify(fixtureHandle) == .classificationUnavailable)
    }
}

private struct FakeContactStore: ContactStoreReading {
    let access: ContactAccess
    let membership: ContactMembership
    let error: (any Error)?

    init(access: ContactAccess, membership: ContactMembership = .notFound, error: (any Error)? = nil) {
        self.access = access
        self.membership = membership
        self.error = error
    }

    func currentAccess() -> ContactAccess { access }

    func membership(for handle: NormalizedHandle) async throws -> ContactMembership {
        if let error { throw error }
        return membership
    }
}

private enum SyntheticError: Error { case failed }
private let fixtureHandle = NormalizedHandle("synthetic@example.invalid")
