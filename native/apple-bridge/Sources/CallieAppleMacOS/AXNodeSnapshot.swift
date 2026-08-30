@preconcurrency import AppKit
@preconcurrency import ApplicationServices
import Dispatch
import Foundation

public enum PhoneAXContract {
    public static let bundleIdentifier = "com.apple.mobilephone"
    public static let applicationURL = "/System/Applications/Phone.app"
    public static let executableURL = "/System/Applications/Phone.app/Contents/MacOS/Phone"
    public static let supportedUIFingerprint = "macos-26.4-phone-v1"
}

public struct PhoneProcessIdentity: Codable, Equatable, Sendable {
    public let processIdentifier: Int32
    public let bundleIdentifier: String
    public let applicationURL: String
    public let executableURL: String

    public init(processIdentifier: Int32, bundleIdentifier: String, applicationURL: String, executableURL: String) {
        self.processIdentifier = processIdentifier
        self.bundleIdentifier = bundleIdentifier
        self.applicationURL = applicationURL
        self.executableURL = executableURL
    }

    var isAuthoritativePhone: Bool {
        processIdentifier > 0
            && bundleIdentifier == PhoneAXContract.bundleIdentifier
            && applicationURL == PhoneAXContract.applicationURL
            && executableURL == PhoneAXContract.executableURL
    }
}

public struct PhoneProcessCandidate: Equatable, Sendable {
    public let identity: PhoneProcessIdentity
    public let phoneUIFingerprint: String

    public init(identity: PhoneProcessIdentity, phoneUIFingerprint: String) {
        self.identity = identity
        self.phoneUIFingerprint = phoneUIFingerprint
    }
}

public protocol PhoneProcessLocating: Sendable {
    func locatePhoneProcess() throws -> PhoneProcessCandidate
}

public protocol RunningPhoneApplicationReading: Sendable {
    func runningPhoneApplications() -> [PhoneProcessCandidate]
}

public struct VerifiedPhoneProcessLocator<Source: RunningPhoneApplicationReading>: PhoneProcessLocating, Sendable {
    private let source: Source

    public init(source: Source) { self.source = source }

    public func locatePhoneProcess() throws -> PhoneProcessCandidate {
        let candidates = source.runningPhoneApplications()
        guard candidates.count == 1, let candidate = candidates.first, candidate.identity.isAuthoritativePhone else {
            throw AXSnapshotError.phoneApplicationUnavailable
        }
        guard candidate.phoneUIFingerprint == PhoneAXContract.supportedUIFingerprint else {
            throw AXSnapshotError.unsupportedPhoneUIVersion
        }
        return candidate
    }
}

public struct SystemRunningPhoneApplicationSource: RunningPhoneApplicationReading, Sendable {
    public init() {}

    public func runningPhoneApplications() -> [PhoneProcessCandidate] {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        let fingerprint = "macos-\(version.majorVersion).\(version.minorVersion)-phone-v1"
        return NSRunningApplication.runningApplications(withBundleIdentifier: PhoneAXContract.bundleIdentifier).compactMap { application in
            guard
                let bundleIdentifier = application.bundleIdentifier,
                let applicationURL = application.bundleURL?.standardizedFileURL.path,
                let executableURL = application.executableURL?.standardizedFileURL.path
            else { return nil }
            return PhoneProcessCandidate(
                identity: PhoneProcessIdentity(
                    processIdentifier: application.processIdentifier,
                    bundleIdentifier: bundleIdentifier,
                    applicationURL: applicationURL,
                    executableURL: executableURL
                ),
                phoneUIFingerprint: fingerprint
            )
        }
    }
}

public struct AXNodeSnapshot: Codable, Equatable, Sendable {
    public let formatVersion: Int
    public let phoneUIFingerprint: String
    public let captureToken: UUID
    public let provenance: PhoneProcessIdentity
    public let root: AXNode

    public init(
        formatVersion: Int,
        phoneUIFingerprint: String,
        captureToken: UUID,
        provenance: PhoneProcessIdentity,
        root: AXNode
    ) {
        self.formatVersion = formatVersion
        self.phoneUIFingerprint = phoneUIFingerprint
        self.captureToken = captureToken
        self.provenance = provenance
        self.root = root
    }
}

public struct AXNode: Codable, Equatable, Sendable {
    public let nodeID: String
    public let role: String
    public let title: String?
    public let identifier: String?
    public let enabled: Bool
    public let value: String?
    public let children: [AXNode]

    public init(nodeID: String, role: String, title: String?, identifier: String?, enabled: Bool, value: String?, children: [AXNode]) {
        self.nodeID = nodeID
        self.role = role
        self.title = title
        self.identifier = identifier
        self.enabled = enabled
        self.value = value
        self.children = children
    }

    var flattened: [AXNode] { [self] + children.flatMap(\.flattened) }
}

public struct AXNodeFields: Equatable, Sendable {
    public let nodeID: String
    public let role: String
    public let title: String?
    public let identifier: String?
    public let enabled: Bool
    public let value: String?

    public init(nodeID: String, role: String, title: String?, identifier: String?, enabled: Bool, value: String?) {
        self.nodeID = nodeID
        self.role = role
        self.title = title
        self.identifier = identifier
        self.enabled = enabled
        self.value = value
    }
}

public protocol AXTraversalNodeReading {
    associatedtype Element: AnyObject
    func fields(of element: Element, path: String) throws -> AXNodeFields
    func children(of element: Element) throws -> [Element]
}

public protocol MonotonicTimeReading: Sendable {
    func nowNanoseconds() -> UInt64
}

public struct SystemMonotonicClock: MonotonicTimeReading, Sendable {
    public init() {}
    public func nowNanoseconds() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
}

public struct AXTraversalLimits: Equatable, Sendable {
    public let maximumDepth: Int
    public let maximumNodeCount: Int
    public let deadlineNanoseconds: UInt64

    public init(maximumDepth: Int = 24, maximumNodeCount: Int = 1_024, deadlineNanoseconds: UInt64 = 250_000_000) {
        self.maximumDepth = max(0, maximumDepth)
        self.maximumNodeCount = max(1, maximumNodeCount)
        self.deadlineNanoseconds = deadlineNanoseconds
    }
}

public struct BoundedAXTraversal<Reader: AXTraversalNodeReading, Clock: MonotonicTimeReading> {
    private let reader: Reader
    private let clock: Clock
    private let limits: AXTraversalLimits

    public init(reader: Reader, clock: Clock, limits: AXTraversalLimits) {
        self.reader = reader
        self.clock = clock
        self.limits = limits
    }

    public func capture(_ root: Reader.Element) throws -> AXNode {
        let started = clock.nowNanoseconds()
        let (deadline, overflow) = started.addingReportingOverflow(limits.deadlineNanoseconds)
        guard !overflow else { throw AXSnapshotError.deadlineExceeded }
        var visited: Set<ObjectIdentifier> = []
        var nodeCount = 0

        func visit(_ element: Reader.Element, path: String, depth: Int) throws -> AXNode {
            func checkDeadline() throws {
                guard clock.nowNanoseconds() <= deadline else { throw AXSnapshotError.deadlineExceeded }
            }
            try checkDeadline()
            guard depth <= limits.maximumDepth else { throw AXSnapshotError.maximumDepthExceeded }
            guard nodeCount < limits.maximumNodeCount else { throw AXSnapshotError.maximumNodeCountExceeded }
            guard visited.insert(ObjectIdentifier(element)).inserted else { throw AXSnapshotError.cycleDetected }
            nodeCount += 1
            let fields = try reader.fields(of: element, path: path)
            try checkDeadline()
            let rawChildren = try reader.children(of: element)
            try checkDeadline()
            let children = try rawChildren.enumerated().map { index, child in
                try visit(child, path: "\(path).\(index)", depth: depth + 1)
            }
            try checkDeadline()
            return AXNode(
                nodeID: fields.nodeID,
                role: fields.role,
                title: fields.title,
                identifier: fields.identifier,
                enabled: fields.enabled,
                value: fields.value,
                children: children
            )
        }

        return try visit(root, path: "root", depth: 0)
    }
}

public protocol AXSnapshotting: Sendable {
    func snapshot() throws -> AXNodeSnapshot
}

public struct AXElementExpectation: Equatable, Sendable {
    public let nodeID: String
    public let role: String
    public let title: String?
    public let identifier: String?
    public let enabled: Bool

    public init(node: AXNode) {
        nodeID = node.nodeID
        role = node.role
        title = node.title
        identifier = node.identifier
        enabled = node.enabled
    }
}

public struct AXActuationRequest: Equatable, Sendable {
    public let captureToken: UUID
    public let provenance: PhoneProcessIdentity
    public let phoneUIFingerprint: String
    public let callWindow: AXElementExpectation
    public let element: AXElementExpectation

    public init(captureToken: UUID, provenance: PhoneProcessIdentity, phoneUIFingerprint: String, callWindow: AXElementExpectation, element: AXElementExpectation) {
        self.captureToken = captureToken
        self.provenance = provenance
        self.phoneUIFingerprint = phoneUIFingerprint
        self.callWindow = callWindow
        self.element = element
    }
}

public protocol AXActuating: Sendable {
    func press(_ request: AXActuationRequest, ifAuthorized: @Sendable () -> Bool) throws
}

public enum AXSnapshotError: Error, Equatable, Sendable {
    case accessibilityDenied
    case phoneApplicationUnavailable
    case unsupportedPhoneUIVersion
    case inspectionFailed
    case elementUnavailable
    case staleCapture
    case liveElementMismatch
    case containmentMismatch
    case actuationFailed
    case maximumDepthExceeded
    case maximumNodeCountExceeded
    case cycleDetected
    case deadlineExceeded
}

public final class SystemPhoneAXAdapter: AXSnapshotting, AXActuating, @unchecked Sendable {
    private struct CaptureRecord {
        let token: UUID
        let process: PhoneProcessCandidate
        let application: AXUIElement
        let elementsByID: [String: AXUIElement]
    }

    private let locator: any PhoneProcessLocating
    private let clock: any MonotonicTimeReading
    private let limits: AXTraversalLimits
    private let lock = NSLock()
    private var currentCapture: CaptureRecord?

    public init(
        locator: any PhoneProcessLocating = VerifiedPhoneProcessLocator(source: SystemRunningPhoneApplicationSource()),
        clock: any MonotonicTimeReading = SystemMonotonicClock(),
        limits: AXTraversalLimits = AXTraversalLimits()
    ) {
        self.locator = locator
        self.clock = clock
        self.limits = limits
    }

    public func snapshot() throws -> AXNodeSnapshot {
        guard AXIsProcessTrusted() else { throw AXSnapshotError.accessibilityDenied }
        let process = try locator.locatePhoneProcess()
        guard process.identity.isAuthoritativePhone else { throw AXSnapshotError.phoneApplicationUnavailable }
        guard process.phoneUIFingerprint == PhoneAXContract.supportedUIFingerprint else { throw AXSnapshotError.unsupportedPhoneUIVersion }
        let application = AXUIElementCreateApplication(process.identity.processIdentifier)
        let reader = SystemAXTraversalReader()
        let root = try BoundedAXTraversal(reader: reader, clock: AnyMonotonicClock(clock), limits: limits).capture(application)
        guard root.role == "AXApplication" else { throw AXSnapshotError.inspectionFailed }
        let token = UUID()
        lock.withLock {
            currentCapture = CaptureRecord(token: token, process: process, application: application, elementsByID: reader.elementsByID)
        }
        return AXNodeSnapshot(
            formatVersion: 1,
            phoneUIFingerprint: process.phoneUIFingerprint,
            captureToken: token,
            provenance: process.identity,
            root: root
        )
    }

    public func press(_ request: AXActuationRequest, ifAuthorized: @Sendable () -> Bool) throws {
        try lock.withLock {
            guard
                let capture = currentCapture,
                capture.token == request.captureToken,
                capture.process.identity == request.provenance
            else { throw AXSnapshotError.staleCapture }
            guard request.phoneUIFingerprint == capture.process.phoneUIFingerprint else { throw AXSnapshotError.liveElementMismatch }
            guard try locator.locatePhoneProcess() == capture.process else { throw AXSnapshotError.phoneApplicationUnavailable }
            guard
                let element = capture.elementsByID[request.element.nodeID],
                let callWindow = capture.elementsByID[request.callWindow.nodeID],
                request.element.nodeID.hasPrefix(request.callWindow.nodeID + ".")
            else { throw AXSnapshotError.containmentMismatch }
            try validateLive(element, expectation: request.element, processIdentifier: capture.process.identity.processIdentifier)
            try validateLive(callWindow, expectation: request.callWindow, processIdentifier: capture.process.identity.processIdentifier)
            guard
                let liveWindow = copyAttribute(element, kAXWindowAttribute),
                CFEqual(liveWindow, callWindow),
                let applicationWindows = copyAttribute(capture.application, kAXWindowsAttribute) as? [AXUIElement],
                applicationWindows.contains(where: { CFEqual($0, callWindow) })
            else { throw AXSnapshotError.containmentMismatch }
            guard ifAuthorized() else { throw PhoneAccessibilityError.callAuthorizationChanged }
            guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { throw AXSnapshotError.actuationFailed }
        }
    }

    private func validateLive(_ element: AXUIElement, expectation: AXElementExpectation, processIdentifier: pid_t) throws {
        var actualPID: pid_t = 0
        guard AXUIElementGetPid(element, &actualPID) == .success, actualPID == processIdentifier else {
            throw AXSnapshotError.containmentMismatch
        }
        guard
            stringAttribute(element, kAXRoleAttribute) == expectation.role,
            stringAttribute(element, kAXTitleAttribute) == expectation.title,
            stringAttribute(element, kAXIdentifierAttribute) == expectation.identifier,
            boolAttribute(element, kAXEnabledAttribute) == expectation.enabled,
            expectation.enabled
        else { throw AXSnapshotError.liveElementMismatch }
    }
}

private struct AnyMonotonicClock: MonotonicTimeReading, @unchecked Sendable {
    private let read: @Sendable () -> UInt64
    init(_ clock: any MonotonicTimeReading) { read = { clock.nowNanoseconds() } }
    func nowNanoseconds() -> UInt64 { read() }
}

private final class SystemAXTraversalReader: AXTraversalNodeReading {
    private(set) var elementsByID: [String: AXUIElement] = [:]

    func fields(of element: AXUIElement, path: String) throws -> AXNodeFields {
        elementsByID[path] = element
        return AXNodeFields(
            nodeID: path,
            role: stringAttribute(element, kAXRoleAttribute) ?? "",
            title: stringAttribute(element, kAXTitleAttribute),
            identifier: stringAttribute(element, kAXIdentifierAttribute),
            enabled: boolAttribute(element, kAXEnabledAttribute) ?? false,
            value: stringAttribute(element, kAXValueAttribute)
        )
    }

    func children(of element: AXUIElement) throws -> [AXUIElement] {
        (copyAttribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }
}

private func copyAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}

private func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    copyAttribute(element, attribute) as? String
}

private func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
    (copyAttribute(element, attribute) as? NSNumber)?.boolValue
}
