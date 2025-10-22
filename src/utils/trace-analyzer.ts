// src/utils/trace-analyzer.ts

/**
 * Analyzes the trace data to find the most significant performance bottleneck.
 * It prioritizes long tasks that have a stack trace, as they are the most actionable.
 * @param traceData The raw trace event data.
 * @returns An object containing details of the worst bottleneck, or a summary if none are found.
 */
export function findWorstBottleneck(traceData: { traceEvents: any[] }) {
  console.log(
    "[SERVER]: Analyzing trace locally to find the worst bottleneck..."
  );

  const longTasks = traceData.traceEvents.filter(
    (event) =>
      event.ph === "X" && // 'X' denotes a complete event
      event.dur > 50000 && // duration is in microseconds (50ms = 50,000µs)
      event.cat?.includes("devtools.timeline")
  );

  if (longTasks.length === 0) {
    return {
      summary:
        "No long tasks were found. The trace appears to be clean.",
    };
  }

  const worstTask = longTasks.reduce(
    (max, task) => (task.dur > max.dur ? task : max),
    longTasks[0]
  );

  // Find child events to populate the 'details'
  const taskStartTime = worstTask.ts;
  const taskEndTime = worstTask.ts + worstTask.dur;
  const childEvents = traceData.traceEvents
    .filter(
      (event) =>
        event.ts >= taskStartTime &&
        event.ts < taskEndTime &&
        event.pid === worstTask.pid &&
        event.tid === worstTask.tid &&
        event !== worstTask // Exclude the task itself
    )
    .map((e) => ({
      name: e.name,
      dur_ms: e.dur / 1000,
      category: e.cat,
      details: e.args,
    }));

  // Extract the most relevant source code location from the stack trace
  let sourceLocation = "Not available";
  const stackTrace = worstTask.args?.data?.stackTrace;
  if (stackTrace && stackTrace.length > 0) {
    // The first frame is often the most specific entry point in the user's code
    const topFrame = stackTrace[0];
    sourceLocation = `${topFrame.url}:${topFrame.lineNumber}:${topFrame.columnNumber}`;
  }

  return {
    description:
      "Found the single longest task with its source code location and child events.",
    eventName: worstTask.name,
    category: worstTask.cat,
    duration_ms: worstTask.dur / 1000,
    sourceLocation: sourceLocation, // The critical piece of new information
    details: {
      original_args: worstTask.args,
      childEvents: childEvents.slice(0, 15), // Include top 15 children for context
    },
  };
}
