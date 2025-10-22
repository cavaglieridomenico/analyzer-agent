// src/utils/trace-analyzer.ts

/**
 * Finds the stack frame from the most significant FunctionCall within a given parent event.
 * @param traceData The full trace data.
 * @param parentEvent The event to search within (e.g., Animation Frame Fired).
 * @returns A stack frame object or null if not found.
 */
function findStackInTrace(
  traceData: { traceEvents: any[] },
  parentEvent: any
): any {
  // First, check if the parent event itself has a stack frame.
  // This handles cases where the bottleneck is a FunctionCall.
  const parentEventData = parentEvent.args?.data;
  if (
    parentEvent.name === "FunctionCall" &&
    parentEventData &&
    parentEventData.url &&
    parentEventData.lineNumber != null &&
    parentEventData.columnNumber != null
  ) {
    return {
      scriptId: parentEventData.scriptId,
      url: parentEventData.url,
      lineNumber: parentEventData.lineNumber + 1, // Convert to 1-indexed
      columnNumber: parentEventData.columnNumber + 1, // Convert to 1-indexed
    };
  }

  // If the parent event doesn't have a stack, search its children.
  // This handles cases like "Animation Frame Fired" which contains other calls.
  const children = traceData.traceEvents.filter(
    (e) =>
      e.ts >= parentEvent.ts &&
      e.ts + e.dur <= parentEvent.ts + parentEvent.dur &&
      e.pid === parentEvent.pid &&
      e.tid === parentEvent.tid &&
      e !== parentEvent
  );

  const functionCalls = children.filter((e) => e.name === "FunctionCall");

  if (functionCalls.length === 0) {
    return null;
  }

  const longestFunctionCall = functionCalls.reduce(
    (max, event) => (event.dur > max.dur ? event : max),
    { dur: 0 }
  );

  if (longestFunctionCall.dur > 0) {
    const eventData = longestFunctionCall.args?.data;
    if (
      eventData &&
      eventData.url &&
      eventData.lineNumber != null &&
      eventData.columnNumber != null
    ) {
      return {
        scriptId: eventData.scriptId,
        url: eventData.url,
        lineNumber: eventData.lineNumber + 1, // Convert to 1-indexed
        columnNumber: eventData.columnNumber + 1, // Convert to 1-indexed
      };
    }
  }

  return null; // No stack frame found.
}

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

  // Find the single longest task event, which acts as a container for child events.
  const longestTask = traceData.traceEvents
    .filter(
      (event) =>
        event.ph === "X" &&
        event.dur > 50000 &&
        event.cat?.includes("devtools.timeline")
    )
    .reduce((max, event) => (event.dur > max.dur ? event : max), { dur: 0 });

  if (longestTask.dur === 0) {
    return {
      summary: "No long tasks were found. The trace appears to be clean.",
    };
  }

  // Now, find the most significant child event within the timeframe of the longest task.
  const taskStartTime = longestTask.ts;
  const taskEndTime = longestTask.ts + longestTask.dur;

  const candidateEventNames = [
    "Animation Frame Fired",
    "RunMicrotasks",
    "FunctionCall",
  ];

  let worstChildEvent: any = { dur: 0 };

  for (const eventName of candidateEventNames) {
    const childEvents = traceData.traceEvents.filter(
      (event) =>
        event.name === eventName &&
        event.ts >= taskStartTime &&
        event.ts < taskEndTime &&
        event.pid === longestTask.pid &&
        event.tid === longestTask.tid
    );

    if (childEvents.length > 0) {
      const longestChild = childEvents.reduce(
        (max, event) => (event.dur > max.dur ? event : max),
        { dur: 0 }
      );
      if (longestChild.dur > worstChildEvent.dur) {
        worstChildEvent = longestChild;
      }
    }
  }

  if (worstChildEvent.dur === 0) {
    return {
      summary: `A long task of ${
        longestTask.dur / 1000
      }ms was found, but it contained no specific child events to analyze (looked for: ${candidateEventNames.join(
        ", "
      )}).`,
    };
  }

  const bottleneckEvent = worstChildEvent;
  const stackFrame = findStackInTrace(traceData, bottleneckEvent);

  if (!stackFrame) {
    // This is where the log message comes from.
    // We return an object with a summary, but no stackFrame.
    return {
      summary: `A bottleneck event (${bottleneckEvent.name}) was found, but no stack frame could be located within it.`,
      details: {
        parent_task_duration_ms: longestTask.dur / 1000,
        bottleneck_duration_ms: bottleneckEvent.dur / 1000,
        function_name: bottleneckEvent.args?.data?.functionName || "N/A",
        original_args: bottleneckEvent.args,
      },
    };
  }

  return {
    eventName: `${longestTask.name} > ${bottleneckEvent.name}`,
    category: bottleneckEvent.cat,
    duration_ms: bottleneckEvent.dur / 1000,
    stackFrame: stackFrame,
    details: {
      parent_task_duration_ms: longestTask.dur / 1000,
      function_name: bottleneckEvent.args?.data?.functionName || "N/A",
      original_args: bottleneckEvent.args,
    },
  };
}
