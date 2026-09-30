/**
 * The pipeline (specification 8.1), drawn as the Kanban in `../pipeline/` (slice K).
 *
 * It was a list of stages with a select on each row until 1.0.14. The decisions that file
 * carried are unchanged and live where they are used now:
 *
 *   * the stages are the workspace's, in the workspace's order, never a hard-coded set;
 *   * a retired stage is shown while something is in it and is never a destination;
 *   * a Lost move needs its reason before the command is sent, and the server is still the
 *     authority (`changeStage` refuses `lost_reason_required` before it writes).
 *
 * This module keeps the name the route imports.
 */
export { Board as PipelineBoard, emptyBoardMemory, type BoardMemory } from '../pipeline/Board.tsx';
