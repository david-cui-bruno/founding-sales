import ApplicationServices
import Foundation

public struct AXNodeSnapshot: Codable, Equatable, Sendable {
    public let formatVersion: Int
    public let phoneUIVersion: String
    public let application: String
    public let root: AXNode

    public init(formatVersion: Int, phoneUIVersion: String, application: String, root: AXNode) {
        self.formatVersion = formatVersion
        self.phoneUIVersion = phoneUIVersion
        self.application = application
        self.root = root
    }

    public var allNodes: [AXNode] {
        root.flattened
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

    public init(
        nodeID: String,
        role: String,
        title: String?,
        identifier: String?,
        enabled: Bool,
        value: String?,
        children: [AXNode]
    ) {
        self.nodeID = nodeID
        self.role = role
        self.title = title
        self.identifier = identifier
        self.enabled = enabled
        self.value = value
        self.children = children
    }

    fileprivate var flattened: [AXNode] {
        [self] + children.flatMap(\.flattened)
    }
}

public protocol AXSnapshotting: Sendable {
    func snapshot() throws -> AXNodeSnapshot
}

public protocol AXActuating: Sendable {
    func press(nodeID: String) throws
}

public enum AXSnapshotError: Error, Equatable, Sendable {
    case accessibilityDenied
    case phoneApplicationUnavailable
    case inspectionFailed
    case elementUnavailable
    case actuationFailed
}

/// The only production boundary that reads or actuates the live Accessibility tree.
/// Tests inject `AXSnapshotting` and `AXActuating` fakes with detached snapshots.
public final class SystemPhoneAXAdapter: AXSnapshotting, AXActuating, @unchecked Sendable {
    private let applicationElement: AXUIElement
    private let phoneUIVersion: String
    private let lock = NSLock()
    private var elementsByID: [String: AXUIElement] = [:]

    public init(processIdentifier: pid_t, phoneUIVersion: String = "macos-26.4") {
        applicationElement = AXUIElementCreateApplication(processIdentifier)
        self.phoneUIVersion = phoneUIVersion
    }

    public func snapshot() throws -> AXNodeSnapshot {
        guard AXIsProcessTrusted() else {
            throw AXSnapshotError.accessibilityDenied
        }

        var captured: [String: AXUIElement] = [:]
        let root = try capture(applicationElement, path: "root", captured: &captured)
        lock.withLock { elementsByID = captured }
        return AXNodeSnapshot(formatVersion: 1, phoneUIVersion: phoneUIVersion, application: "Phone", root: root)
    }

    public func press(nodeID: String) throws {
        let element = lock.withLock { elementsByID[nodeID] }
        guard let element else {
            throw AXSnapshotError.elementUnavailable
        }
        guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
            throw AXSnapshotError.actuationFailed
        }
    }

    private func capture(_ element: AXUIElement, path: String, captured: inout [String: AXUIElement]) throws -> AXNode {
        captured[path] = element
        let children = (copyAttribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
        let capturedChildren = try children.enumerated().map { index, child in
            try capture(child, path: "\(path).\(index)", captured: &captured)
        }
        return AXNode(
            nodeID: path,
            role: stringAttribute(element, kAXRoleAttribute) ?? "",
            title: stringAttribute(element, kAXTitleAttribute),
            identifier: stringAttribute(element, kAXIdentifierAttribute),
            enabled: boolAttribute(element, kAXEnabledAttribute) ?? false,
            value: stringAttribute(element, kAXValueAttribute),
            children: capturedChildren
        )
    }

    private func copyAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value
    }

    private func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        copyAttribute(element, attribute) as? String
    }

    private func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
        (copyAttribute(element, attribute) as? NSNumber)?.boolValue
    }
}
