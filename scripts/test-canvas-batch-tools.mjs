import assert from "node:assert/strict";
import { resolveProjectAfterLegacySave } from "../frontend/modules/features/canvas/batch-tools.js";

const project = (id, updatedAt) => ({ id, updatedAt });

async function resolvesKnownCleanCanvasImmediatelyAfterGracePeriod() {
  const calls = [];
  const result = await resolveProjectAfterLegacySave({
    nodeIds: ["image-a", "image-b"],
    knownProjectTimeoutMs: 0,
    pollMs: 0,
    wait: () => new Promise((resolve) => setTimeout(resolve, 1)),
    saveCanvas: () => true,
    invokeCommand: async (command) => {
      calls.push(command);
      if (command === "list_project_summaries") return [project("project-a", "before")];
      if (command === "find_project_for_canvas_selection") return "project-a";
      throw new Error(`unexpected command ${command}`);
    },
  });
  assert.equal(result, "project-a");
  assert.deepEqual(calls, ["list_project_summaries", "find_project_for_canvas_selection"]);
}

async function waitsForAnUnsavedSelectionToPersist() {
  let summaries = 0;
  const result = await resolveProjectAfterLegacySave({
    nodeIds: ["image-new-a", "image-new-b"],
    timeoutMs: 20,
    pollMs: 0,
    wait: () => new Promise((resolve) => setTimeout(resolve, 1)),
    saveCanvas: () => true,
    invokeCommand: async (command) => {
      if (command === "find_project_for_canvas_selection") return "project-new";
      if (command === "list_project_summaries") {
        summaries += 1;
        return [project("project-new", summaries === 1 ? "before" : "after")];
      }
      throw new Error(`unexpected command ${command}`);
    },
  });
  assert.equal(result, "project-new");
}

async function rejectsAmbiguousOrUnavailableSaveTargets() {
  const notSaved = await resolveProjectAfterLegacySave({
    nodeIds: ["image-a", "image-b"],
    saveCanvas: () => false,
    invokeCommand: async (command) => command === "list_project_summaries" ? [] : null,
  });
  assert.equal(notSaved, undefined);

  const missing = await resolveProjectAfterLegacySave({
    nodeIds: ["image-a", "image-b"],
    timeoutMs: 0,
    saveCanvas: () => true,
    invokeCommand: async (command) => command === "list_project_summaries" ? [project("other", "before")] : null,
  });
  assert.equal(missing, null);
}

await resolvesKnownCleanCanvasImmediatelyAfterGracePeriod();
await waitsForAnUnsavedSelectionToPersist();
await rejectsAmbiguousOrUnavailableSaveTargets();
console.log("Canvas batch compatibility tests passed.");
