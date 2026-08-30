import Foundation
import Testing
@testable import CallieAppleMacOS

@Suite("AXTraversalTests")
struct AXTraversalTests {
    @Test func depthLimitFailsPrecisely() {
        let leaf = TraversalFixtureNode("leaf")
        let middle = TraversalFixtureNode("middle", children: [leaf])
        let root = TraversalFixtureNode("root", children: [middle])
        let traversal = fixtureTraversal(limits: .init(maximumDepth: 1, maximumNodeCount: 10, deadlineNanoseconds: 100))

        #expect(throws: AXSnapshotError.maximumDepthExceeded) { try traversal.capture(root) }
    }

    @Test func nodeCountLimitFailsPrecisely() {
        let root = TraversalFixtureNode("root", children: [TraversalFixtureNode("a"), TraversalFixtureNode("b")])
        let traversal = fixtureTraversal(limits: .init(maximumDepth: 4, maximumNodeCount: 2, deadlineNanoseconds: 100))

        #expect(throws: AXSnapshotError.maximumNodeCountExceeded) { try traversal.capture(root) }
    }

    @Test func cycleFailsPrecisely() {
        let root = TraversalFixtureNode("root")
        root.children = [root]
        let traversal = fixtureTraversal(limits: .init(maximumDepth: 4, maximumNodeCount: 10, deadlineNanoseconds: 100))

        #expect(throws: AXSnapshotError.cycleDetected) { try traversal.capture(root) }
    }

    @Test func monotonicDeadlineFailsPrecisely() {
        let root = TraversalFixtureNode("root", children: [TraversalFixtureNode("child")])
        let traversal = BoundedAXTraversal(
            reader: TraversalFixtureReader(),
            clock: SequenceMonotonicClock([0, 50, 101]),
            limits: .init(maximumDepth: 4, maximumNodeCount: 10, deadlineNanoseconds: 100)
        )

        #expect(throws: AXSnapshotError.deadlineExceeded) { try traversal.capture(root) }
    }

    @Test func workCrossingDeadlineOnSingleNodeFailsPrecisely() {
        let traversal = BoundedAXTraversal(
            reader: TraversalFixtureReader(),
            clock: SequenceMonotonicClock([0, 0, 101]),
            limits: .init(maximumDepth: 4, maximumNodeCount: 10, deadlineNanoseconds: 100)
        )

        #expect(throws: AXSnapshotError.deadlineExceeded) {
            try traversal.capture(TraversalFixtureNode("root"))
        }
    }
}

private final class TraversalFixtureNode: @unchecked Sendable {
    let name: String
    var children: [TraversalFixtureNode]
    init(_ name: String, children: [TraversalFixtureNode] = []) { self.name = name; self.children = children }
}

private struct TraversalFixtureReader: AXTraversalNodeReading {
    func fields(of element: TraversalFixtureNode, path: String) throws -> AXNodeFields {
        AXNodeFields(nodeID: path, role: "AXGroup", title: element.name, identifier: element.name, enabled: true, value: nil)
    }
    func children(of element: TraversalFixtureNode) throws -> [TraversalFixtureNode] { element.children }
}

private final class SequenceMonotonicClock: MonotonicTimeReading, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [UInt64]
    init(_ values: [UInt64]) { self.values = values }
    func nowNanoseconds() -> UInt64 { lock.withLock { values.removeFirst() } }
}

private func fixtureTraversal(limits: AXTraversalLimits) -> BoundedAXTraversal<TraversalFixtureReader, SequenceMonotonicClock> {
    BoundedAXTraversal(reader: TraversalFixtureReader(), clock: SequenceMonotonicClock(Array(repeating: 0, count: 20)), limits: limits)
}
