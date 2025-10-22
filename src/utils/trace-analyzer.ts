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

  // Now, find the longest "FunctionCall" within the timeframe of the longest task.
  // This is where the actionable stack information will be.
  const taskStartTime = longestTask.ts;
  const taskEndTime = longestTask.ts + longestTask.dur;

  const childFunctionCalls = traceData.traceEvents.filter(
    (event) =>
      event.name === "FunctionCall" &&
      event.ts >= taskStartTime &&
      event.ts < taskEndTime &&
      event.pid === longestTask.pid &&
      event.tid === longestTask.tid
  );

  if (childFunctionCalls.length === 0) {
    return {
      summary: `A long task of ${
        longestTask.dur / 1000
      }ms was found, but it contained no specific FunctionCall events to analyze.`,
    };
  }

  // Find the longest function call within the parent task
  const worstFunctionCall = childFunctionCalls.reduce(
    (max, event) => (event.dur > max.dur ? event : max),
    { dur: 0 }
  );

  const functionCallData = worstFunctionCall.args.data;
  let stackFrame = null;

  // The trace gives 0-indexed line/column, but source-map needs 1-indexed.
  if (
    functionCallData &&
    functionCallData.url &&
    functionCallData.lineNumber != null &&
    functionCallData.columnNumber != null
  ) {
    stackFrame = {
      scriptId: functionCallData.scriptId,
      url: functionCallData.url,
      lineNumber: functionCallData.lineNumber + 1, // Convert to 1-indexed
      columnNumber: functionCallData.columnNumber + 1, // Convert to 1-indexed
    };
  }

  return {
    eventName: `${longestTask.name} > ${worstFunctionCall.name}`,
    category: worstFunctionCall.cat,
    duration_ms: worstFunctionCall.dur / 1000,
    // Raw data for the controller to use, extracted from the FunctionCall
    stackFrame: stackFrame,
    details: {
      parent_task_duration_ms: longestTask.dur / 1000,
      function_name: functionCallData.functionName,
      original_args: worstFunctionCall.args,
    },
  };
}
