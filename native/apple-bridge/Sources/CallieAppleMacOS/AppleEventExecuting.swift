import Foundation

public enum FixedAppleEventOperation: Sendable, Equatable {
    case notesScanAttachments(since: Date)
    case notesSaveAttachment(scriptingID: String, destination: URL)
    case messagesResolveParticipants(handle: String)
    case messagesSend(participantID: String, body: String)
}

public enum AppleEventExecutionError: Error, Sendable, Equatable {
    case descriptorConstructionFailed
    case failed
    case missingReply
}

public protocol AppleEventExecuting: Sendable {
    func execute(_ operation: FixedAppleEventOperation) throws -> NSAppleEventDescriptor
}

public struct SystemAppleEventExecutor: AppleEventExecuting {
    public init() {}

    public func execute(_ operation: FixedAppleEventOperation) throws -> NSAppleEventDescriptor {
        let descriptor = try FixedAppleEventDescriptorFactory.descriptor(for: operation)
        do {
            return try descriptor.sendEvent(
                options: [.waitForReply, .neverInteract, .dontRecord],
                timeout: 2
            )
        } catch let error as AppleEventExecutionError {
            throw error
        } catch {
            throw AppleEventExecutionError.failed
        }
    }
}

public enum FixedAppleEventDescriptorFactory {
    private static let notesBundleIdentifier = "com.apple.Notes"
    private static let messagesBundleIdentifier = "com.apple.MobileSMS"

    public static func descriptor(for operation: FixedAppleEventOperation) throws -> NSAppleEventDescriptor {
        switch operation {
        case let .notesScanAttachments(since):
            let event = appleEvent(target: notesBundleIdentifier, eventClass: code("core"), eventID: code("getd"))
            let examined = NSAppleEventDescriptor(descriptorType: code("exmn"), data: Data())!
            let creationDate = try objectSpecifier(
                desiredClass: code("prop"),
                form: code("prop"),
                selection: .init(typeCode: code("ascd")),
                container: examined
            )
            let comparison = try comparisonDescriptor(
                lhs: creationDate,
                rhs: .init(date: since),
                operation: code(">=  ")
            )
            let matchingAttachments = try objectSpecifier(
                desiredClass: code("atts"),
                form: code("test"),
                selection: comparison,
                container: .null()
            )
            // Notes exposes no stable sort command in its installed public SDEF. Ask
            // for one bounded page of the fixed since-filter and let the typed result
            // report truncation whenever the sentinel (501st) candidate is present.
            let range = NSAppleEventDescriptor.record()
            range.setDescriptor(.init(int32: 1), forKeyword: code("star"))
            range.setDescriptor(.init(int32: 501), forKeyword: code("stop"))
            guard let rangeSelection = range.coerce(toDescriptorType: code("rang")) else {
                throw AppleEventExecutionError.descriptorConstructionFailed
            }
            let boundedAttachments = try objectSpecifier(
                desiredClass: code("atts"),
                form: code("rang"),
                selection: rangeSelection,
                container: matchingAttachments
            )
            let properties = try objectSpecifier(
                desiredClass: code("prop"),
                form: code("prop"),
                selection: .init(typeCode: code("pALL")),
                container: boundedAttachments
            )
            event.setParam(properties, forKeyword: code("----"))
            return event
        case let .notesSaveAttachment(scriptingID, destination):
            guard destination.isFileURL else { throw AppleEventExecutionError.descriptorConstructionFailed }
            let event = appleEvent(target: notesBundleIdentifier, eventClass: code("core"), eventID: code("save"))
            let attachment = try objectSpecifier(
                desiredClass: code("atts"),
                form: code("ID  "),
                selection: .init(string: scriptingID),
                container: .null()
            )
            event.setParam(attachment, forKeyword: code("----"))
            event.setParam(.init(fileURL: destination), forKeyword: code("kfil"))
            return event
        case let .messagesResolveParticipants(handle):
            let event = appleEvent(target: messagesBundleIdentifier, eventClass: code("core"), eventID: code("getd"))
            let examined = NSAppleEventDescriptor(descriptorType: code("exmn"), data: Data())!
            let handleProperty = try objectSpecifier(
                desiredClass: code("prop"),
                form: code("prop"),
                selection: .init(typeCode: code("hndl")),
                container: examined
            )
            let comparison = try comparisonDescriptor(lhs: handleProperty, rhs: .init(string: handle), operation: code("=   "))
            let participants = try objectSpecifier(
                desiredClass: code("pres"),
                form: code("test"),
                selection: comparison,
                container: .null()
            )
            let identifiers = try objectSpecifier(
                desiredClass: code("prop"),
                form: code("prop"),
                selection: .init(typeCode: code("ID  ")),
                container: participants
            )
            event.setParam(identifiers, forKeyword: code("----"))
            return event
        case let .messagesSend(participantID, body):
            let event = appleEvent(target: messagesBundleIdentifier, eventClass: code("icht"), eventID: code("send"))
            let participant = try objectSpecifier(
                desiredClass: code("pres"),
                form: code("ID  "),
                selection: .init(string: participantID),
                container: .null()
            )
            event.setParam(.init(string: body), forKeyword: code("----"))
            event.setParam(participant, forKeyword: code("TO  "))
            return event
        }
    }

    private static func comparisonDescriptor(
        lhs: NSAppleEventDescriptor,
        rhs: NSAppleEventDescriptor,
        operation: UInt32
    ) throws -> NSAppleEventDescriptor {
        let record = NSAppleEventDescriptor.record()
        record.setDescriptor(.init(enumCode: operation), forKeyword: code("relo"))
        record.setDescriptor(lhs, forKeyword: code("obj1"))
        record.setDescriptor(rhs, forKeyword: code("obj2"))
        guard let comparison = record.coerce(toDescriptorType: code("cmpd")) else {
            throw AppleEventExecutionError.descriptorConstructionFailed
        }
        return comparison
    }

    private static func appleEvent(target: String, eventClass: UInt32, eventID: UInt32) -> NSAppleEventDescriptor {
        let targetDescriptor = NSAppleEventDescriptor(bundleIdentifier: target)
        let event = NSAppleEventDescriptor(
            eventClass: eventClass,
            eventID: eventID,
            targetDescriptor: targetDescriptor,
            returnID: -1,
            transactionID: 0
        )
        event.setAttribute(targetDescriptor, forKeyword: code("addr"))
        return event
    }

    private static func objectSpecifier(
        desiredClass: UInt32,
        form: UInt32,
        selection: NSAppleEventDescriptor,
        container: NSAppleEventDescriptor
    ) throws -> NSAppleEventDescriptor {
        let record = NSAppleEventDescriptor.record()
        record.setDescriptor(.init(typeCode: desiredClass), forKeyword: code("want"))
        record.setDescriptor(.init(enumCode: form), forKeyword: code("form"))
        record.setDescriptor(selection, forKeyword: code("seld"))
        record.setDescriptor(container, forKeyword: code("from"))
        guard let specifier = record.coerce(toDescriptorType: code("obj ")) else {
            throw AppleEventExecutionError.descriptorConstructionFailed
        }
        return specifier
    }

    private static func code(_ value: String) -> UInt32 {
        value.utf8.reduce(0) { ($0 << 8) | UInt32($1) }
    }
}
