// src/utils/trace-analyzer.ts

/**
 * Analyzes the trace data to find the most significant performance bottleneck.
 * It finds the longest task and extracts its details and stack trace for further analysis.
 * @param traceData The raw trace event data.
 * @returns An object containing details of the worst bottleneck, or a summary if none are found.
 */
export function findWorstBottleneck(traceData: { traceEvents: any[] }) {
  console.log(
    "[SERVER]: Analyzing trace locally to find the worst bottleneck..."
  );

  // Prioritize long tasks that have a stack trace, as they are the most actionable.
  const longTasksWithStack = traceData.traceEvents.filter(
    (event) =>
      event.ph === "X" && // 'X' denotes a complete event
      event.dur > 50000 && // duration is in microseconds (50ms = 50,000µs)
      event.cat?.includes("devtools.timeline") &&
      event.args?.data?.stackTrace?.length > 0
  );

  let worstTask;

  if (longTasksWithStack.length > 0) {
    worstTask = longTasksWithStack.reduce(
      (max, task) => (task.dur > max.dur ? task : max),
      longTasksWithStack[0]
    );
  } else {
    // If no tasks with stack traces are found, find the longest task overall.
    const allLongTasks = traceData.traceEvents.filter(
      (event) =>
        event.ph === "X" &&
        event.dur > 50000 &&
        event.cat?.includes("devtools.timeline")
    );

    if (allLongTasks.length === 0) {
      return {
        summary: "No long tasks were found. The trace appears to be clean.",
      };
    }
    worstTask = allLongTasks.reduce(
      (max, task) => (task.dur > max.dur ? task : max),
      allLongTasks[0]
    );
  }

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

  // Extract raw stack trace info if available, but don't resolve it here.
  const stackTrace = worstTask.args?.data?.stackTrace;
  const topFrame = stackTrace && stackTrace.length > 0 ? stackTrace[0] : null;

  return {
    eventName: worstTask.name,
    category: worstTask.cat,
    duration_ms: worstTask.dur / 1000,
    // Raw data for the controller to use
    stackFrame: topFrame
      ? {
          scriptId: topFrame.scriptId,
          url: topFrame.url,
          lineNumber: topFrame.lineNumber,
          columnNumber: topFrame.columnNumber,
        }
      : null,
    details: {
      original_args: worstTask.args,
      childEvents: childEvents.slice(0, 15),
    },
  };
}
