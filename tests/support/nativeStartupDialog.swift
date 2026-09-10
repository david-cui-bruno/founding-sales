import Foundation
import AppKit
import ApplicationServices
import Darwin

// Test-only: exactly one captured packaged child, AXWindows only, no menus/focus.
private struct Failure: Error { let code: String }
private let message = "Callie startup did not complete."
private let detail = "APPLICATION_STARTUP_FAILED\nQuit Callie to close this attempt. If Restart Callie is offered, you can try starting it again."
private let deadline = ProcessInfo.processInfo.systemUptime + 8
private func fail(_ code: String) throws -> Never { throw Failure(code: code) }
private func checkTime() throws {
    if ProcessInfo.processInfo.systemUptime >= deadline { try fail("DIALOG_DEADLINE") }
}
// An incomplete scan is a fixed failure, never evidence of absence/uniqueness.
private func attribute(_ element: AXUIElement, _ key: String,
                       absentErrors: [AXError] = []) throws -> CFTypeRef? {
    try checkTime()
    guard AXUIElementSetMessagingTimeout(element, 0.1) == .success else { try fail("AX_TIMEOUT_CONFIGURATION") }
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, key as CFString, &value)
    if error != .success {
        guard absentErrors.contains(error) else { try fail("AX_ATTRIBUTE_READ") }
        return nil
    }
    guard let value = value else { try fail("AX_SUCCESS_WITHOUT_VALUE") }
    return value
}
private func stringAttribute(_ element: AXUIElement, _ key: String) throws -> String {
    guard let value = try attribute(element, key), CFGetTypeID(value) == CFStringGetTypeID(),
          let text = value as? String else { try fail("AX_STRING_TYPE") }
    return text
}
private func elementsAttribute(_ element: AXUIElement, _ key: String,
                               absentErrors: [AXError] = []) throws -> [AXUIElement] {
    guard let value = try attribute(element, key, absentErrors: absentErrors) else { return [] }
    guard CFGetTypeID(value) == CFArrayGetTypeID(), let values = value as? [AnyObject],
          values.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }),
          let elements = value as? [AXUIElement] else { try fail("AX_ELEMENT_ARRAY_TYPE") }
    return elements
}
private func enabledAttribute(_ element: AXUIElement) throws -> Bool {
    guard let value = try attribute(element, kAXEnabledAttribute),
          CFGetTypeID(value) == CFBooleanGetTypeID(), let boolean = value as? NSNumber else {
        try fail("AX_BOOLEAN_TYPE")
    }
    return boolean.boolValue
}
private struct ProcessStart: Equatable { let seconds: UInt64; let microseconds: UInt64 }
private func processStart(_ pid: Int32, _ earliest: Double) throws -> ProcessStart {
    try checkTime()
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    let returned = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size)
    guard returned == size, info.pbi_pid == UInt32(pid) else { try fail("PROCESS_START_READ") }
    let seconds = UInt64(info.pbi_start_tvsec)
    let microseconds = UInt64(info.pbi_start_tvusec)
    guard seconds > 0, microseconds < 1_000_000 else { try fail("PROCESS_START_VALUE") }
    let timestamp = Double(seconds) + Double(microseconds) / 1_000_000
    guard timestamp.isFinite, timestamp >= earliest - 2,
          timestamp <= Date().timeIntervalSince1970 + 1 else { try fail("PROCESS_START_BOUNDS") }
    try checkTime()
    return ProcessStart(seconds: seconds, microseconds: microseconds)
}
private struct Match { let window: AXUIElement; let quit: AXUIElement }
private func find(_ app: AXUIElement) throws -> [Match] {
    // Never ask the application for AXChildren: that would traverse its menu bar.
    let windows = try elementsAttribute(app, kAXWindowsAttribute, absentErrors: [.noValue])
    guard windows.count <= 8 else { try fail("WINDOW_BOUND") }
    var matches: [Match] = []
    var count = 0
    for window in windows {
        guard try stringAttribute(window, kAXRoleAttribute) == kAXWindowRole else { try fail("WINDOW_ROLE") }
        var texts: [String] = []
        var buttons: [(String, Bool, AXUIElement)] = []
        func visit(_ node: AXUIElement, _ depth: Int) throws {
            try checkTime()
            count += 1
            guard depth <= 8, count <= 128 else { try fail("TREE_BOUND") }
            let role = try stringAttribute(node, kAXRoleAttribute)
            guard role != kAXMenuRole, role != kAXMenuBarRole else { try fail("MENU_NOT_ALLOWED") }
            if role == kAXStaticTextRole {
                let value = try stringAttribute(node, kAXValueAttribute)
                guard value.utf8.count <= 512 else { try fail("TEXT_BOUND") }
                texts.append(value)
            }
            if role == kAXButtonRole {
                let title = try stringAttribute(node, kAXTitleAttribute)
                guard title.utf8.count <= 64 else { try fail("BUTTON_TITLE") }
                let enabled = try enabledAttribute(node)
                buttons.append((title, enabled, node))
            }
            // Only these known leaf roles may omit AXChildren. Unknown/container
            // roles must return a correctly typed array, including when empty.
            let leaf = [kAXStaticTextRole, kAXButtonRole, kAXImageRole].contains(role)
            let children = try elementsAttribute(node, kAXChildrenAttribute,
                absentErrors: leaf ? [.attributeUnsupported, .noValue] : [])
            guard children.count <= 128 else { try fail("CHILD_BOUND") }
            for child in children { try visit(child, depth + 1) }
        }
        try visit(window, 0)
        if texts.contains(message) || texts.contains(detail) {
            guard texts.sorted() == [message, detail].sorted(), buttons.count == 2,
                  buttons.map({ $0.0 }).sorted() == ["Quit", "Restart Callie"].sorted(),
                  buttons.allSatisfy({ $0.1 }), let quit = buttons.first(where: { $0.0 == "Quit" }) else {
                try fail("FATAL_WINDOW_MISMATCH")
            }
            matches.append(Match(window: window, quit: quit.2))
        }
    }
    return matches
}
private func output(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

do {
    let args = CommandLine.arguments
    guard args.count == 4, let pid = Int32(args[1]), pid > 1,
          let earliest = Double(args[3]), earliest.isFinite else { try fail("ARGUMENTS") }
    guard AXIsProcessTrusted() else { try fail("AX_PERMISSION") }
    let expected = URL(fileURLWithPath: args[2]).resolvingSymlinksInPath().path
    guard let initial = NSRunningApplication(processIdentifier: pid), !initial.isTerminated,
          let executable = initial.executableURL,
          executable.resolvingSymlinksInPath().path == expected else { try fail("PROCESS_IDENTITY") }
    let started = try processStart(pid, earliest)
    func identity() throws {
        try checkTime()
        guard let current = NSRunningApplication(processIdentifier: pid), !current.isTerminated,
              let url = current.executableURL,
              url.resolvingSymlinksInPath().path == expected else { try fail("PROCESS_CHANGED") }
        guard try processStart(pid, earliest) == started else { try fail("PROCESS_CHANGED") }
    }
    let app = AXUIElementCreateApplication(pid)
    var found: Match?
    while found == nil {
        try identity()
        let candidates = try find(app)
        guard candidates.count <= 1 else { try fail("AMBIGUOUS_FATAL_WINDOW") }
        found = candidates.first
        if found == nil { Thread.sleep(forTimeInterval: 0.05) }
    }
    guard let observed = found else { try fail("FATAL_WINDOW_ABSENT") }
    // Re-observe exact content and enabled controls, and bind the same AX window/button.
    try identity()
    let fresh = try find(app)
    guard fresh.count == 1, CFEqual(fresh[0].window, observed.window), CFEqual(fresh[0].quit, observed.quit) else {
        try fail("FATAL_WINDOW_CHANGED")
    }
    try identity()
    guard AXUIElementPerformAction(fresh[0].quit, kAXPressAction as CFString) == .success else { try fail("QUIT_PRESS_FAILED") }
    try output(["formatVersion": 1, "pid": Int(pid), "executable": expected,
                "processStart": ["seconds": started.seconds, "microseconds": started.microseconds],
                "observed": true, "pressed": true,
                "message": message, "detail": detail, "buttons": ["Quit", "Restart Callie"]])
    exit(0)
} catch {
    let code = (error as? Failure)?.code ?? "HELPER_INTERNAL_ERROR"
    // Fixed bounded error only. No AX tree, private paths or crash backtrace.
    try? output(["error": code])
    exit(1)
}
