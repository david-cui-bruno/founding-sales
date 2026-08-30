import Contacts
import Foundation
import CallieAppleCore

public protocol ContactStoreReading: Sendable {
    func currentAccess() -> ContactAccess
    func membership(for handle: NormalizedHandle) async throws -> ContactMembership
}

public protocol ContactAuthorizationReading: Sendable {
    func currentContactAccess() -> ContactAccess
}

public protocol ContactAccessRequesting: Sendable {
    func requestContactAccess() async throws -> Bool
}

public enum ContactsClassification: Equatable, Sendable {
    case resolved(IdentityResolution)
    case classificationUnavailable
}

public struct ContactsClassifier<Store: ContactStoreReading>: Sendable {
    private let store: Store

    public init(store: Store) {
        self.store = store
    }

    public func classify(_ handle: NormalizedHandle) async -> ContactsClassification {
        guard store.currentAccess() == .full else {
            return .classificationUnavailable
        }
        do {
            let membership = try await store.membership(for: handle)
            return .resolved(.resolved(handle, contactMembership: membership))
        } catch {
            return .classificationUnavailable
        }
    }
}

/// The only production boundary that constructs and queries `CNContactStore`.
public final class SystemContactStore: ContactStoreReading, ContactAuthorizationReading, ContactAccessRequesting, @unchecked Sendable {
    private let store: CNContactStore

    public init() {
        store = CNContactStore()
    }

    public func currentAccess() -> ContactAccess {
        Self.contactAccess(forAuthorizationRawValue: CNContactStore.authorizationStatus(for: .contacts).rawValue)
    }

    public func currentContactAccess() -> ContactAccess {
        currentAccess()
    }

    public func membership(for handle: NormalizedHandle) async throws -> ContactMembership {
        guard currentAccess() == .full else {
            throw ContactsClassifierError.fullAccessRequired
        }
        let predicate: NSPredicate
        if handle.value.contains("@") {
            predicate = CNContact.predicateForContacts(matchingEmailAddress: handle.value)
        } else {
            predicate = CNContact.predicateForContacts(matching: CNPhoneNumber(stringValue: handle.value))
        }
        let contacts = try store.unifiedContacts(
            matching: predicate,
            keysToFetch: [CNContactIdentifierKey as CNKeyDescriptor]
        )
        return contacts.isEmpty ? .notFound : .found
    }

    public func requestContactAccess() async throws -> Bool {
        try await withCheckedThrowingContinuation { continuation in
            store.requestAccess(for: .contacts) { granted, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: granted)
                }
            }
        }
    }

    static func contactAccess(forAuthorizationRawValue rawValue: Int) -> ContactAccess {
        switch rawValue {
        case 0: .notDetermined
        case 1: .restricted
        case 2: .denied
        case 3: .full
        case 4: .limited
        default: .denied
        }
    }
}

public enum ContactsClassifierError: Error, Equatable, Sendable {
    case fullAccessRequired
}
